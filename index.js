"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const { spawn } = require("child_process");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const SCRIPT_DIR = path.join(ROOT, "script");

const PORT = Number(
  process.env.PORT ||
  process.env.BOT_PORT ||
  10000
);

for (const dir of [DATA_DIR, PUBLIC_DIR, SCRIPT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      prefix: "/",
      admins: [],
      bot: {
        listenEvents: true,
        selfListen: false,
        online: true
      }
    }, null, 2)
  );
}

if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, "[]");
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const config = readJSON(CONFIG_FILE, {});

const state = {
  online: false,
  worker: false,
  loggedIn: false,
  botID: null,

  startedAt: Date.now(),

  messagesReceived: 0,
  messagesSent: 0,
  duplicatesSuppressed: 0,
  cooldownSuppressed: 0,
  queueSuppressed: 0,
  errors: 0,

  commandsLoaded: 0,
  commandNames: [],

  hunting: {},

  lastError: null,
  lastMessageAt: null,
  lastSendAt: null
};

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

let workerProcess = null;
let restartTimer = null;
let shuttingDown = false;

function uptime() {
  const seconds = Math.floor((Date.now() - state.startedAt) / 1000);

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function sendToWorker(message) {
  if (!workerProcess) return false;

  try {
    workerProcess.send(message);
    return true;
  } catch {
    return false;
  }
}

function startWorker() {
  if (shuttingDown) return;

  if (workerProcess) {
    try {
      workerProcess.kill();
    } catch {}
  }

  console.log("[NULLFIED] Starting bot worker...");

  workerProcess = spawn(
    process.execPath,
    [path.join(ROOT, "auto.js")],
    {
      cwd: ROOT,
      env: process.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"]
    }
  );

  state.worker = true;

  workerProcess.on("message", message => {
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "status":
        Object.assign(state, message.data || {});
        break;

      case "stats":
        Object.assign(state, message.data || {});
        break;

      case "hunting":
        state.hunting = message.data || {};
        break;

      case "error":
        state.errors++;
        state.lastError = message.message || "Unknown worker error";
        break;
    }
  });

  workerProcess.on("error", err => {
    state.worker = false;
    state.online = false;
    state.errors++;
    state.lastError = err.message;

    console.error("[WORKER ERROR]", err);
  });

  workerProcess.on("exit", (code, signal) => {
    state.worker = false;
    state.online = false;
    state.loggedIn = false;

    console.log(
      `[NULLFIED] Worker stopped. code=${code} signal=${signal}`
    );

    workerProcess = null;

    if (shuttingDown) return;

    clearTimeout(restartTimer);

    restartTimer = setTimeout(() => {
      startWorker();
    }, 10000);
  });
}

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    status: state,
    uptime: uptime(),
    now: new Date().toISOString()
  });
});

app.get("/api/commands", (req, res) => {
  res.json({
    ok: true,
    count: state.commandsLoaded,
    commands: state.commandNames
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    config: {
      prefix: config.prefix,
      admins: config.admins || [],
      traffic: config.traffic || {},
      typing: config.typing || {}
    }
  });
});

app.post("/api/restart", (req, res) => {
  if (!workerProcess) {
    startWorker();

    return res.json({
      ok: true,
      message: "Worker started."
    });
  }

  try {
    workerProcess.kill("SIGTERM");
  } catch {}

  res.json({
    ok: true,
    message: "Restart requested."
  });
});

app.post("/api/hunting", (req, res) => {
  const action = String(req.body.action || "").toLowerCase();

  const allowed = [
    "status",
    "on",
    "off"
  ];

  if (!allowed.includes(action)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid action."
    });
  }

  const sent = sendToWorker({
    type: "dashboard_hunting",
    action
  });

  res.json({
    ok: sent,
    message: sent
      ? `Hunting ${action} request sent.`
      : "Worker is offline."
  });
});

app.get("/health", (req, res) => {
  res.status(state.worker ? 200 : 503).json({
    ok: state.worker,
    uptime: uptime()
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("=================================");
  console.log("       NULLFIED BOT SERVER");
  console.log("=================================");
  console.log(`Dashboard: http://0.0.0.0:${PORT}`);
  console.log("=================================");
  console.log("");

  startWorker();
});

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`[NULLFIED] ${signal} received.`);

  clearTimeout(restartTimer);

  if (workerProcess) {
    try {
      workerProcess.kill("SIGTERM");
    } catch {}
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", err => {
  state.errors++;
  state.lastError = err.message;

  console.error("[UNCAUGHT]", err);
});

process.on("unhandledRejection", err => {
  state.errors++;

  state.lastError =
    err && err.message
      ? err.message
      : String(err);

  console.error("[UNHANDLED]", err);
});
