"use strict";

const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const { login } = require("biar-fca");

const ROOT = __dirname;

const DATA_DIR = path.join(ROOT, "data");
const SCRIPT_DIR = path.join(ROOT, "script");

const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const APPSTATE_FILE = path.join(DATA_DIR, "appstate.json");

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const config = readJSON(CONFIG_FILE, {});

const ADMIN_IDS = new Set(
  Array.isArray(config.admins)
    ? config.admins.map(String)
    : []
);

const commands = new Map();
const events = [];

let api = null;
let botID = null;
let listener = null;

const runtime = {
  online: false,
  loggedIn: false,

  messagesReceived: 0,
  messagesSent: 0,

  duplicatesSuppressed: 0,
  cooldownSuppressed: 0,
  queueSuppressed: 0,

  errors: 0,

  commandsLoaded: 0,
  commandNames: [],

  lastMessageAt: null,
  lastSendAt: null,

  startedAt: Date.now()
};

const duplicateCache = new Map();
const userCooldowns = new Map();
const threadCooldowns = new Map();

const threadQueues = new Map();
const threadSending = new Set();

const burstMap = new Map();

function notify(type, data) {
  if (typeof process.send !== "function") return;

  try {
    process.send({
      type,
      data
    });
  } catch {}
}

function notifyError(message) {
  runtime.errors++;

  if (typeof process.send !== "function") return;

  try {
    process.send({
      type: "error",
      message: String(message)
    });
  } catch {}
}

function report() {
  notify("status", {
    ...runtime,
    online: runtime.online,
    loggedIn: runtime.loggedIn,
    botID,
    hunting: global.huntingState || {}
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function random(min, max) {
  return Math.floor(
    Math.random() * (max - min + 1)
  ) + min;
}

function isAdmin(id) {
  return ADMIN_IDS.has(String(id));
}

function safeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeDuplicateKey(event) {
  return [
    event.threadID,
    event.senderID,
    safeText(event.body).toLowerCase()
  ].join(":");
}

function checkDuplicate(event) {
  const windowMs =
    Number(config.traffic?.duplicateWindow) || 5000;

  const key = makeDuplicateKey(event);
  const now = Date.now();

  const previous = duplicateCache.get(key);

  duplicateCache.set(key, now);

  if (previous && now - previous < windowMs) {
    runtime.duplicatesSuppressed++;
    return true;
  }

  if (duplicateCache.size > 2000) {
    for (const [k, time] of duplicateCache) {
      if (now - time > windowMs * 2) {
        duplicateCache.delete(k);
      }
    }
  }

  return false;
}

function checkBurst(threadID) {
  const maxBurst =
    Number(config.traffic?.maxBurst) || 5;

  const windowMs =
    Number(config.traffic?.burstWindow) || 15000;

  const now = Date.now();

  let data = burstMap.get(threadID);

  if (!data) {
    data = [];
    burstMap.set(threadID, data);
  }

  data.push(now);

  while (
    data.length &&
    now - data[0] > windowMs
  ) {
    data.shift();
  }

  return data.length > maxBurst;
}

function canReply(event) {
  const now = Date.now();

  const userDelay =
    Number(config.traffic?.userCooldown) || 2500;

  const threadDelay =
    Number(config.traffic?.minReplyInterval) || 5000;

  const userKey =
    `${event.threadID}:${event.senderID}`;

  const lastUser =
    userCooldowns.get(userKey) || 0;

  if (now - lastUser < userDelay) {
    runtime.cooldownSuppressed++;
    return false;
  }

  const lastThread =
    threadCooldowns.get(event.threadID) || 0;

  if (now - lastThread < threadDelay) {
    runtime.cooldownSuppressed++;
    return false;
  }

  userCooldowns.set(userKey, now);
  threadCooldowns.set(event.threadID, now);

  return true;
}

function typing(threadID, state) {
  return new Promise(resolve => {
    if (!api || typeof api.sendTypingIndicator !== "function") {
      return resolve();
    }

    try {
      api.sendTypingIndicator(
        threadID,
        state,
        () => resolve()
      );
    } catch {
      resolve();
    }
  });
}

async function humanTyping(threadID) {
  if (!config.typing?.enabled) return;

  const min =
    Number(config.typing?.minDelay) || 900;

  const max =
    Number(config.typing?.maxDelay) || 2200;

  await typing(threadID, true);
  await sleep(random(min, max));
  await typing(threadID, false);
}

function rawSend(message, threadID, replyTo) {
  return new Promise(resolve => {
    if (!api) return resolve(false);

    let finished = false;

    const done = err => {
      if (finished) return;

      finished = true;

      if (err) {
        runtime.errors++;
        console.error("[SEND ERROR]", err);
        return resolve(false);
      }

      runtime.messagesSent++;
      runtime.lastSendAt = new Date().toISOString();

      resolve(true);
    };

    try {
      if (
        replyTo &&
        typeof api.sendMessageMqtt === "function"
      ) {
        api.sendMessageMqtt(
          message,
          threadID,
          replyTo,
          done
        );

        return;
      }

      api.sendMessage(
        message,
        threadID,
        done
      );
    } catch (err) {
      console.error("[SEND THROW]", err);
      done(err);
    }
  });
}

async function processThreadQueue(threadID) {
  if (threadSending.has(threadID)) return;

  threadSending.add(threadID);

  try {
    const queue =
      threadQueues.get(threadID) || [];

    while (queue.length) {
      const item = queue.shift();

      await humanTyping(threadID);

      await rawSend(
        item.message,
        threadID,
        item.replyTo
      );

      await sleep(
        Number(config.traffic?.sendSpacing) || 1800
      );
    }
  } finally {
    threadSending.delete(threadID);
  }
}

async function safeSend(
  threadID,
  message,
  options = {}
) {
  const queue =
    threadQueues.get(threadID) || [];

  const maxQueue =
    Number(config.traffic?.maxQueuePerThread) || 3;

  if (queue.length >= maxQueue) {
    runtime.queueSuppressed++;
    return false;
  }

  queue.push({
    message,
    replyTo: options.replyTo || null
  });

  threadQueues.set(threadID, queue);

  processThreadQueue(threadID);

  return true;
}

function directSend(
  threadID,
  message,
  replyTo
) {
  return rawSend(
    message,
    threadID,
    replyTo
  );
}

function react(threadID, messageID, emoji) {
  return new Promise(resolve => {
    if (!api || typeof api.setMessageReaction !== "function") {
      return resolve(false);
    }

    try {
      api.setMessageReaction(
        emoji,
        messageID,
        () => resolve(true),
        true
      );
    } catch {
      resolve(false);
    }
  });
}

function markRead(threadID) {
  if (!api || typeof api.markAsRead !== "function") {
    return;
  }

  try {
    api.markAsRead(threadID, () => {});
  } catch {}
}

function getCommand(name) {
  if (!name) return null;

  const key = String(name)
    .toLowerCase()
    .trim();

  return commands.get(key) || null;
}

function registerCommand(module, file) {
  if (!module) return;

  const configObject =
    module.config || module;

  const name =
    configObject.name ||
    module.name;

  if (!name) return;

  const command = {
    ...module,
    config: configObject,
    file
  };

  commands.set(
    String(name).toLowerCase(),
    command
  );

  if (Array.isArray(configObject.aliases)) {
    for (const alias of configObject.aliases) {
      commands.set(
        String(alias).toLowerCase(),
        command
      );
    }
  }
}

function loadCommands() {
  commands.clear();

  if (!fs.existsSync(SCRIPT_DIR)) {
    fs.mkdirSync(SCRIPT_DIR, {
      recursive: true
    });
  }

  const files = fs.readdirSync(SCRIPT_DIR)
    .filter(file => file.endsWith(".js"));

  for (const file of files) {
    const fullPath =
      path.join(SCRIPT_DIR, file);

    try {
      delete require.cache[
        require.resolve(fullPath)
      ];

      const module = require(fullPath);

      registerCommand(
        module,
        file
      );

      console.log(
        chalk.green(`[COMMAND] ${file}`)
      );
    } catch (err) {
      console.error(
        chalk.red(`[COMMAND ERROR] ${file}`),
        err
      );

      notifyError(
        `${file}: ${err.message}`
      );
    }
  }

  runtime.commandsLoaded = commands.size;

  runtime.commandNames = [
    ...new Set(
      [...commands.values()]
        .map(command =>
          command.config?.name
        )
        .filter(Boolean)
    )
  ].sort();

  report();
}

function parseCommand(body) {
  const text = safeText(body);

  if (!text) return null;

  const prefix =
    String(config.prefix || "/");

  if (text.startsWith(prefix)) {
    const content =
      text.slice(prefix.length).trim();

    if (!content) return null;

    const parts =
      content.split(/\s+/);

    const name =
      parts.shift().toLowerCase();

    const command =
      getCommand(name);

    if (!command) return null;

    return {
      command,
      args: parts
    };
  }

  const parts =
    text.split(/\s+/);

  const name =
    parts.shift().toLowerCase();

  const command =
    getCommand(name);

  if (!command) return null;

  const commandConfig =
    command.config || {};

  const prefixless =
    commandConfig.usePrefix === false ||
    commandConfig.hasPrefix === false;

  if (!prefixless) return null;

  return {
    command,
    args: parts
  };
}

async function executeCommand(
  command,
  args,
  event
) {
  const commandConfig =
    command.config || {};

  const permission =
    Number(commandConfig.hasPermission || 0);

  if (permission >= 2 && !isAdmin(event.senderID)) {
    await safeSend(
      event.threadID,
      "⛔ Admin only.",
      {
        replyTo: event.messageID
      }
    );

    return;
  }

  const context = {
    api,
    event,

    args,
    body: event.body || "",

    threadID: event.threadID,
    messageID: event.messageID,
    senderID: event.senderID,

    prefix: config.prefix || "/",

    commands,
    config,
    account: {
      id: botID
    },

    isAdmin: () =>
      isAdmin(event.senderID),

    safeSend,

    sendMessage: safeSend,

    directSend,

    typing: humanTyping,

    react: async emoji =>
      react(
        event.threadID,
        event.messageID,
        emoji
      ),

    notifyHunting: data =>
      notify("hunting", data)
  };

  try {
    if (typeof command.run === "function") {
      return await command.run(context);
    }

    if (typeof command.execute === "function") {
      return await command.execute(context);
    }

    if (typeof command.onStart === "function") {
      return await command.onStart(context);
    }
  } catch (err) {
    notifyError(
      `Command ${commandConfig.name}: ${err.message}`
    );

    console.error(
      `[COMMAND ERROR] ${commandConfig.name}`,
      err
    );

    await safeSend(
      event.threadID,
      "⚠️ Command error.",
      {
        replyTo: event.messageID
      }
    );
  }
}

async function handleMessage(event) {
  if (!event) return;

  runtime.messagesReceived++;
  runtime.lastMessageAt =
    new Date().toISOString();

  if (!event.threadID) return;

  markRead(event.threadID);

  if (checkDuplicate(event)) {
    return;
  }

  if (checkBurst(event.threadID)) {
    runtime.cooldownSuppressed++;
    return;
  }

  if (!event.body) {
    return;
  }

  const parsed =
    parseCommand(event.body);

  if (parsed) {
    await executeCommand(
      parsed.command,
      parsed.args,
      event
    );

    return;
  }

  for (const command of commands.values()) {
    if (
      typeof command.handleEvent !== "function"
    ) {
      continue;
    }

    try {
      await command.handleEvent({
        api,
        event,

        args: [],

        body: event.body || "",

        threadID: event.threadID,
        messageID: event.messageID,
        senderID: event.senderID,

        config,

        account: {
          id: botID
        },

        isAdmin: () =>
          isAdmin(event.senderID),

        safeSend,

        sendMessage: safeSend,

        directSend,

        typing: humanTyping,

        react: async emoji =>
          react(
            event.threadID,
            event.messageID,
            emoji
          ),

        notifyHunting: data =>
          notify("hunting", data)
      });
    } catch (err) {
      notifyError(
        `Event handler error: ${err.message}`
      );
    }
  }

  report();
}

function getAppState() {
  if (process.env.APPSTATE_JSON) {
    try {
      const parsed =
        JSON.parse(process.env.APPSTATE_JSON);

      if (!Array.isArray(parsed)) {
        throw new Error(
          "APPSTATE_JSON must be a JSON array."
        );
      }

      return parsed;
    } catch (err) {
      throw new Error(
        `Invalid APPSTATE_JSON: ${err.message}`
      );
    }
  }

  if (!fs.existsSync(APPSTATE_FILE)) {
    throw new Error(
      "No appstate found. Set Render APPSTATE_JSON or create data/appstate.json."
    );
  }

  const appState =
    readJSON(APPSTATE_FILE, null);

  if (!Array.isArray(appState) || !appState.length) {
    throw new Error(
      "data/appstate.json is empty or invalid."
    );
  }

  return appState;
}

async function loginBot() {
  let appState;

  try {
    appState = getAppState();
  } catch (err) {
    notifyError(err.message);

    console.error(
      chalk.red(`[AUTH] ${err.message}`)
    );

    return;
  }

  console.log(
    chalk.cyan("[AUTH] Logging in with biar-fca...")
  );

  login(
    {
      appState
    },
    {
      online: Boolean(
        config.bot?.online !== false
      ),

      listenEvents: Boolean(
        config.bot?.listenEvents !== false
      ),

      selfListen: Boolean(
        config.bot?.selfListen === true
      ),

      updatePresence: false,
      autoMarkDelivery: true,
      autoMarkRead: false
    },
    (err, client) => {
      if (err) {
        runtime.online = false;
        runtime.loggedIn = false;

        notifyError(
          err?.message ||
          err?.error ||
          String(err)
        );

        console.error(
          chalk.red("[AUTH ERROR]"),
          err
        );

        report();
        return;
      }

      api = client;

      try {
        if (
          typeof api.getCurrentUserID === "function"
        ) {
          botID = String(
            api.getCurrentUserID()
          );
        }
      } catch {}

      runtime.online = true;
      runtime.loggedIn = true;

      console.log(
        chalk.green(
          `[NULLFIED] ONLINE${botID ? ` | ID ${botID}` : ""}`
        )
      );

      loadCommands();
      report();

      try {
        api.setOptions({
          listenEvents: Boolean(
            config.bot?.listenEvents !== false
          ),

          selfListen: Boolean(
            config.bot?.selfListen === true
          ),

          online: Boolean(
            config.bot?.online !== false
          )
        });
      } catch {}

      listener = api.listenMqtt(
        async (listenErr, event) => {
          if (listenErr) {
            runtime.online = false;

            notifyError(
              listenErr?.message ||
              String(listenErr)
            );

            console.error(
              chalk.red("[LISTENER ERROR]"),
              listenErr
            );

            report();
            return;
          }

          runtime.online = true;

          if (!event) return;

          if (event.type === "message") {
            await handleMessage(event);
          }
        }
      );

      report();
    }
  );
}

process.on(
  "message",
  async message => {
    if (!message) return;

    if (
      message.type === "dashboard_hunting"
    ) {
      const action =
        String(message.action || "")
          .toLowerCase();

      if (
        global.huntingDashboard &&
        typeof global.huntingDashboard === "function"
      ) {
        try {
          await global.huntingDashboard(action);
        } catch (err) {
          notifyError(err.message);
        }
      }
    }
  }
);

setInterval(() => {
  const now = Date.now();

  const duplicateWindow =
    Number(config.traffic?.duplicateWindow) || 5000;

  for (const [key, time] of duplicateCache) {
    if (now - time > duplicateWindow * 3) {
      duplicateCache.delete(key);
    }
  }

  for (const [key, time] of userCooldowns) {
    if (now - time > 60000) {
      userCooldowns.delete(key);
    }
  }

  for (const [key, time] of threadCooldowns) {
    if (now - time > 60000) {
      threadCooldowns.delete(key);
    }
  }

  report();
}, 10000);

process.on(
  "uncaughtException",
  err => {
    notifyError(err.message);
    console.error("[UNCAUGHT]", err);
  }
);

process.on(
  "unhandledRejection",
  err => {
    notifyError(
      err?.message || String(err)
    );

    console.error("[UNHANDLED]", err);
  }
);

loadCommands();
loginBot();
