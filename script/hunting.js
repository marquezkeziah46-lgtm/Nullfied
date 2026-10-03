"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "hunting-state.json");

const ADMINS = new Set([
  "61594616562680",
  "61594981323552"
]);

const REPLY_INTERVAL = 10000;
const DUPLICATE_WINDOW = 5000;

const MAX_COUNT = 50;
const COUNT_INTERVAL = 1000;

const MAX_HISTORY = 30;

// ============================================================
// TAGALOG DRY / TAUNT REPLIES
// Walang "agreeing" replies.
// ============================================================

const replies = [
  "ano ba yan",
  "luh",
  "eto na naman",
  "ulit ka na naman",
  "ang ingay mo",
  "tahimik ka nga",
  "ano pinagsasabi mo",
  "di ka pa tapos",
  "may gana ka pa",
  "sige ka lang",
  "hanggang dyan ka lang",
  "ano raw",
  "weh",
  "sus",
  "hay nako",
  "kaloka ka",
  "ang kulit",
  "paulit-ulit",
  "wala na bang bago",
  "same script",
  "lumang banat",
  "yan lang",
  "yun na yon",
  "tapos na?",
  "may kasunod pa?",
  "bitin naman",
  "ang haba naman",
  "nakakatamad basahin",
  "di ko babasahin lahat",
  "skip ko na",
  "next",
  "move on",
  "iba naman",
  "palit banat",
  "baguhin mo naman",
  "wag ganyan",
  "ano ginagawa mo",
  "bakit ganyan",
  "saan papunta yan",
  "naliligaw ka ata",
  "ano connect",
  "wala sa topic",
  "layo ng sagot",
  "napunta na naman kung saan",
  "kalma ka",
  "hinga muna",
  "wag ka excited",
  "wag ka maingay",
  "ang seryoso mo",
  "seryoso ka dyan",
  "haha",
  "hehe",
  "lmao",
  "lol",
  "bruh",
  "bro ano yan",
  "tol ano yan",
  "pre wag",
  "beh kalma",
  "lods ano ba",
  "gulo mo",
  "lutang ka",
  "nalito ka na",
  "nakalimutan mo ata",
  "balikan mo muna",
  "isip ulit",
  "try mo pa",
  "isa pa",
  "ulit",
  "ulit pa",
  "next attempt",
  "anong klaseng banat yan",
  "parang wala lang",
  "walang dating",
  "mahaba pero wala",
  "dami sinabi",
  "ang dami mong sinabi",
  "may point ba",
  "san banda",
  "asan yung point",
  "wala na?",
  "yun lang?",
  "tapos na agad",
  "bitin",
  "ang tahimik bigla",
  "nawala ka",
  "nasaan ka",
  "hello",
  "gising",
  "online ka pa?",
  "ano na",
  "tagal",
  "busy ka ba",
  "loading ka?"
];

// ============================================================
// ABBREVIATIONS / SHORT DRY REPLIES
// ============================================================

const shortReplies = [
  "k",
  "luh",
  "weh",
  "sus",
  "lol",
  "haha",
  "hehe",
  "bruh",
  "tol",
  "pre",
  "beh",
  "lods",
  "ano",
  "ha?",
  "wdym",
  "idk",
  "fr?",
  "huh",
  "uh",
  "hmm",
  "next",
  "ulit",
  "skip",
  "pass",
  "meh",
  "gg?",
  "wtf",
  "bro",
  "geez",
  "lmao"
];

// ============================================================
// HUMAN MIMICKER
// Hindi ito agreeing.
// Parang panggagaya / pang-aasar.
// ============================================================

const mimickerReplies = [
  "ano ano",
  "luh luh",
  "sus sus",
  "haha haha",
  "ulit ulit",
  "paulit ulit",
  "ingay ingay",
  "kalma kalma",
  "excited excited",
  "seryoso seryoso",
  "haba haba",
  "dami dami",
  "ano raw ano raw",
  "yan na yan na",
  "next next",
  "isa pa isa pa",
  "gulo gulo",
  "lutang lutang",
  "loading loading",
  "tagal tagal",
  "saan saan",
  "bakit bakit",
  "ano ano ba",
  "luh ano luh",
  "ulit na naman",
  "eto na naman",
  "ingay mo ingay",
  "haba mo haba",
  "seryoso ka seryoso",
  "kalma lang kalma",
  "next na next",
  "isa pa nga isa pa",
  "ano yan ano yan",
  "bakit ganyan bakit",
  "san banda san",
  "may point point",
  "wala wala",
  "bitin bitin"
];

// ============================================================
// COUNT REPLIES
// ============================================================

const countReplies = [
  "nagbibilang pa...",
  "sandali lang...",
  "bilang muna...",
  "teka lang...",
  "counting muna...",
  "wait lang...",
  "may ginagawa pa...",
  "bilang tayo..."
];

const stopReplies = [
  "tigil na",
  "cancel na",
  "sige tama na",
  "stop na",
  "ayan tigil",
  "wag na",
  "tapos na yan"
];

const state = {
  enabledThreads: {},
  gcName: {},
  lockedGC: {},
  nickname: {},
  stats: {},
  usedReplies: {},
  lastReply: {},
  lastMessage: {}
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

function loadState() {
  ensureDir();

  try {
    if (!fs.existsSync(STATE_FILE)) {
      saveState();
      return;
    }

    const parsed = JSON.parse(
      fs.readFileSync(
        STATE_FILE,
        "utf8"
      )
    );

    Object.assign(state, parsed);
  } catch (err) {
    console.error(
      "[HUNTING] State load error:",
      err
    );
  }
}

function saveState() {
  ensureDir();

  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        state,
        null,
        2
      )
    );
  } catch (err) {
    console.error(
      "[HUNTING] State save error:",
      err
    );
  }
}

loadState();

global.huntingState = state.enabledThreads;

global.huntingDashboard = async action => {
  return action;
};

function isAdmin(id) {
  return ADMINS.has(String(id));
}

function random(array) {
  return array[
    Math.floor(
      Math.random() * array.length
    )
  ];
}

function pickReply(threadID) {
  if (!state.usedReplies[threadID]) {
    state.usedReplies[threadID] = [];
  }

  const history =
    state.usedReplies[threadID];

  const pool = [
    ...replies,
    ...shortReplies,
    ...mimickerReplies
  ];

  let available = pool.filter(
    reply => !history.includes(reply)
  );

  if (!available.length) {
    history.splice(
      0,
      Math.floor(history.length / 2)
    );

    available = pool.filter(
      reply => !history.includes(reply)
    );
  }

  const selected = random(available);

  history.push(selected);

  while (
    history.length > MAX_HISTORY
  ) {
    history.shift();
  }

  return selected;
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function markStats(threadID) {
  if (!state.stats[threadID]) {
    state.stats[threadID] = {
      replies: 0,
      counts: 0
    };
  }
}

function getStatus(threadID) {
  markStats(threadID);

  return [
    "╭─〔 NULLFIED HUNTING 〕",
    `│ Status: ${
      state.enabledThreads[threadID]
        ? "ON"
        : "OFF"
    }`,
    `│ Replies: ${
      state.stats[threadID].replies
    }`,
    `│ Counts: ${
      state.stats[threadID].counts
    }`,
    `│ GC Lock: ${
      state.lockedGC[threadID]
        ? "ON"
        : "OFF"
    }`,
    `│ GC Name: ${
      state.gcName[threadID] ||
      "default"
    }`,
    `│ Nickname: ${
      state.nickname[threadID] ||
      "default"
    }`,
    "╰────────────────"
  ].join("\n");
}

async function send(
  ctx,
  text,
  reply = true
) {
  if (!ctx || !ctx.safeSend) {
    return false;
  }

  return ctx.safeSend(
    ctx.threadID,
    text,
    reply
      ? {
          replyTo: ctx.messageID
        }
      : {}
  );
}

async function countEngine(ctx) {
  const threadID =
    ctx.threadID;

  markStats(threadID);

  if (
    global.huntingCountRunning &&
    global.huntingCountRunning[threadID]
  ) {
    await send(
      ctx,
      "⚠️ May count na tumatakbo."
    );

    return;
  }

  if (!global.huntingCountRunning) {
    global.huntingCountRunning = {};
  }

  global.huntingCountRunning[
    threadID
  ] = true;

  state.stats[threadID].counts++;

  saveState();

  await send(
    ctx,
    random(countReplies)
  );

  for (
    let i = 1;
    i <= MAX_COUNT;
    i++
  ) {
    if (
      !global.huntingCountRunning[
        threadID
      ]
    ) {
      break;
    }

    if (
      i === 10 ||
      i === 25 ||
      i === 50
    ) {
      await send(
        ctx,
        `〔 COUNT 〕 ${i}/${MAX_COUNT}`
      );
    }

    await sleep(COUNT_INTERVAL);
  }

  if (
    global.huntingCountRunning[
      threadID
    ]
  ) {
    await send(
      ctx,
      [
        "╭─〔 RESIBO 〕",
        "│ Hunting count complete.",
        `│ Total: ${MAX_COUNT}`,
        "│ Status: DONE",
        "╰────────────"
      ].join("\n")
    );
  }

  delete global.huntingCountRunning[
    threadID
  ];

  saveState();
}

function helpText() {
  return [
    "╭─〔 NULLFIED HUNTING 〕",
    "│ hunting",
    "│ hunting on",
    "│ hunting off",
    "│ hunting count",
    "│ hunting count stop",
    "│ hunting status",
    "│ hunting stats",
    "│ hunting nickname <name>",
    "│ hunting gcname <name>",
    "│ hunting lock",
    "│ hunting unlock",
    "│ hunting reset",
    "╰────────────────"
  ].join("\n");
}

async function command(ctx) {
  const args =
    Array.isArray(ctx.args)
      ? ctx.args
      : [];

  const action =
    String(
      args[0] || ""
    ).toLowerCase();

  const threadID =
    ctx.threadID;

  markStats(threadID);

  if (!action) {
    return send(
      ctx,
      helpText()
    );
  }

  if (
    action === "on" ||
    action === "start" ||
    action === "enable"
  ) {
    state.enabledThreads[
      threadID
    ] = true;

    global.huntingState =
      state.enabledThreads;

    saveState();

    if (ctx.notifyHunting) {
      ctx.notifyHunting(
        state.enabledThreads
      );
    }

    return send(
      ctx,
      "🥷 Hunting mode: ON"
    );
  }

  if (
    action === "off" ||
    action === "stop" ||
    action === "disable"
  ) {
    state.enabledThreads[
      threadID
    ] = false;

    global.huntingState =
      state.enabledThreads;

    saveState();

    if (ctx.notifyHunting) {
      ctx.notifyHunting(
        state.enabledThreads
      );
    }

    return send(
      ctx,
      "🥷 Hunting mode: OFF"
    );
  }

  if (
    action === "status" ||
    action === "stats"
  ) {
    return send(
      ctx,
      getStatus(threadID)
    );
  }

  if (action === "count") {
    if (
      String(args[1] || "")
        .toLowerCase() === "stop"
    ) {
      if (
        global.huntingCountRunning &&
        global.huntingCountRunning[
          threadID
        ]
      ) {
        global.huntingCountRunning[
          threadID
        ] = false;

        return send(
          ctx,
          random(stopReplies)
        );
      }

      return send(
        ctx,
        "Walang active count."
      );
    }

    return countEngine(ctx);
  }

  if (
    action === "nickname" ||
    action === "nick"
  ) {
    if (!isAdmin(ctx.senderID)) {
      return send(
        ctx,
        "⛔ Admin only."
      );
    }

    const name =
      args
        .slice(1)
        .join(" ")
        .trim();

    if (!name) {
      return send(
        ctx,
        "Usage: hunting nickname <name>"
      );
    }

    state.nickname[
      threadID
    ] = name;

    saveState();

    return send(
      ctx,
      `Nickname saved: ${name}`
    );
  }

  if (
    action === "gcname" ||
    action === "groupname"
  ) {
    if (!isAdmin(ctx.senderID)) {
      return send(
        ctx,
        "⛔ Admin only."
      );
    }

    const name =
      args
        .slice(1)
        .join(" ")
        .trim();

    if (!name) {
      return send(
        ctx,
        "Usage: hunting gcname <name>"
      );
    }

    state.gcName[
      threadID
    ] = name;

    saveState();

    return send(
      ctx,
      `GC name saved: ${name}`
    );
  }

  if (action === "lock") {
    if (!isAdmin(ctx.senderID)) {
      return send(
        ctx,
        "⛔ Admin only."
      );
    }

    state.lockedGC[
      threadID
    ] = true;

    saveState();

    return send(
      ctx,
      "🔒 GC name lock: ON"
    );
  }

  if (action === "unlock") {
    if (!isAdmin(ctx.senderID)) {
      return send(
        ctx,
        "⛔ Admin only."
      );
    }

    state.lockedGC[
      threadID
    ] = false;

    saveState();

    return send(
      ctx,
      "🔓 GC name lock: OFF"
    );
  }

  if (action === "reset") {
    if (!isAdmin(ctx.senderID)) {
      return send(
        ctx,
        "⛔ Admin only."
      );
    }

    delete state.stats[threadID];
    delete state.usedReplies[threadID];
    delete state.lastReply[threadID];

    saveState();

    return send(
      ctx,
      "♻️ Hunting data reset."
    );
  }

  return send(
    ctx,
    helpText()
  );
}

async function handleEvent(ctx) {
  if (!ctx || !ctx.event) {
    return;
  }

  const event = ctx.event;

  const threadID =
    event.threadID;

  if (
    !state.enabledThreads[
      threadID
    ]
  ) {
    return;
  }

  const body =
    String(
      event.body || ""
    )
      .trim()
      .toLowerCase();

  if (!body) return;

  const trigger =
    body === "hunt" ||
    body === "hunting" ||
    body.startsWith("hunt ") ||
    body.startsWith("hunting ");

  if (!trigger) {
    return;
  }

  const now = Date.now();

  const previous =
    state.lastMessage[
      threadID
    ];

  const messageKey =
    `${event.senderID}:${body}`;

  if (
    previous &&
    previous.key === messageKey &&
    now - previous.time <
      DUPLICATE_WINDOW
  ) {
    return;
  }

  state.lastMessage[
    threadID
  ] = {
    key: messageKey,
    time: now
  };

  const lastReply =
    state.lastReply[
      threadID
    ] || 0;

  if (
    now - lastReply <
    REPLY_INTERVAL
  ) {
    return;
  }

  state.lastReply[
    threadID
  ] = now;

  markStats(threadID);

  state.stats[
    threadID
  ].replies++;

  saveState();

  const reply =
    pickReply(threadID);

  await send(
    ctx,
    reply
  );
}

module.exports = {
  config: {
    name: "hunting",
    version: "3.0.0",
    credits: "Sinzu",
    description:
      "Prefixless Tagalog dry/taunting Hunting system.",
    hasPermission: 0,

    usePrefix: false,
    hasPrefix: false,

    aliases: [
      "hunt"
    ]
  },

  run: command,
  handleEvent
};

Result: hindi na siya puro "g", "copy", "noted", "bet", etc. Ang automatic hunting replies ay mas dry, dismissive, pang-aasar, Tagalog, may abbreviations at mimicker, at may 60+ regular replies + short replies + mimicker replies para mas hindi madaling maulit.
