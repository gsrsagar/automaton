/**
 * Conway Automaton Dashboard
 * Real-time web UI with chat, logs, goals, tool calls.
 * 
 * Usage: node dashboard.cjs
 * Opens at http://localhost:3847
 */

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = 3847;
const AUTOMATON_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || "/root",
  ".automaton"
);
const DB_PATH = path.join(AUTOMATON_DIR, "state.db");

// ─── Database (read-write for chat) ────────────────────────────
let db;
try {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
} catch (e) {
  console.error(`Cannot open ${DB_PATH}:`, e.message);
  process.exit(1);
}

// ─── Express + WebSocket ───────────────────────────────────────
const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, "dashboard-public")));

// ─── SSE endpoint for live logs ────────────────────────────────
const logClients = new Set();
app.get("/api/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  logClients.add(res);
  req.on("close", () => logClients.delete(res));
});

function broadcastLog(line) {
  for (const client of logClients) {
    client.write(`data: ${JSON.stringify({ line, ts: Date.now() })}\n\n`);
  }
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "log", line }));
  }
}

function broadcast(data) {
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }
}

// ─── Chat API ──────────────────────────────────────────────────
const chatHistory = [];
const pendingResponses = new Map();

app.post("/api/chat", (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message required" });
    }

    const userMsg = {
      id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      content: message.trim(),
      ts: Date.now(),
    };
    chatHistory.push(userMsg);
    broadcast({ type: "chat", message: userMsg });

    // Insert into inbox_messages so the agent picks it up
    const msgId = `inbox-chat-${Date.now()}`;
    const walletAddr = getIdentity().address || "0x0000000000000000000000000000000000000000";

    // Get current turn count to detect new turns
    let turnCountBefore = 0;
    try {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM turns").get();
      turnCountBefore = row?.cnt || 0;
    } catch {}

    try {
      db.prepare(
        `INSERT INTO inbox_messages (id, from_address, content, received_at, status)
         VALUES (?, ?, ?, datetime('now'), 'received')`
      ).run(msgId, walletAddr, message.trim());
    } catch (e) {
      // If table doesn't exist or schema mismatch, try alternate approach
      console.error("Inbox insert failed:", e.message);
      return res.status(500).json({ error: "Failed to send message: " + e.message });
    }

    // Store pending response info
    pendingResponses.set(msgId, {
      turnCountBefore,
      userMsgId: userMsg.id,
      startTime: Date.now(),
    });

    res.json({ ok: true, msgId, turnCountBefore });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/chat/history", (req, res) => {
  res.json(chatHistory.slice(-100));
});

app.get("/api/chat/pending/:msgId", (req, res) => {
  const pending = pendingResponses.get(req.params.msgId);
  if (!pending) return res.json({ found: false });

  // Check if any new turns appeared since we sent the message
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM turns").get();
    const currentCount = row?.cnt || 0;

    if (currentCount > pending.turnCountBefore) {
      // Get the latest turn's thinking/response
      const latestTurn = db
        .prepare(
          `SELECT t.thinking, t.token_usage as tokenCount, tc.name, tc.result
           FROM turns t
           LEFT JOIN tool_calls tc ON tc.turn_id = t.id
           ORDER BY t.created_at DESC LIMIT 1`
        )
        .get();

      // Check if the agent processed our inbox message
      const processed = db
        .prepare(
          `SELECT processed_at FROM inbox_messages WHERE id = ?`
        ).get(req.params.msgId);

      const response = {
        found: true,
        completed: !!processed?.processed_at,
        turnCount: currentCount,
        thinking: latestTurn?.thinking || "",
        toolsUsed: latestTurn?.name || "",
      };

      if (response.completed) pendingResponses.delete(req.params.msgId);
      res.json(response);
    } else {
      res.json({ found: true, completed: false });
    }
  } catch (e) {
    res.json({ found: true, completed: false });
  }
});

// Get latest agent response from turns
app.get("/api/chat/response", (req, res) => {
  try {
    const turn = db
      .prepare(
        `SELECT t.id, t.created_at as timestamp, t.thinking, t.token_usage as tokenCount,
                tc.name as toolName, tc.arguments as toolArgs, tc.result as toolResult
         FROM turns t
         LEFT JOIN tool_calls tc ON tc.turn_id = t.id
         ORDER BY t.created_at DESC LIMIT 1`
      )
      .get();
    res.json(turn || {});
  } catch (e) {
    res.json({});
  }
});

// ─── Status API ────────────────────────────────────────────────
function getIdentity() {
  const identity = {};
  try {
    const rows = db.prepare("SELECT key, value FROM identity").all();
    for (const r of rows) identity[r.key] = r.value;
  } catch {}
  return identity;
}

app.get("/api/status", (req, res) => {
  try {
    const identity = getIdentity();
    let turns = 0;
    try { turns = db.prepare("SELECT COUNT(*) as cnt FROM turns").get()?.cnt || 0; } catch {}

    let recentTurns = [];
    try {
      recentTurns = db.prepare(
        `SELECT t.id, t.created_at as timestamp, t.state, t.thinking, t.token_usage as tokenCount, t.cost_cents as costCents,
                tc.name as toolName, tc.arguments as toolArgs, tc.result as toolResult
         FROM turns t LEFT JOIN tool_calls tc ON tc.turn_id = t.id
         ORDER BY t.created_at DESC LIMIT 50`
      ).all();
    } catch (e) { console.error("recentTurns query error:", e.message); }

    let goals = [];
    try { goals = db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all(); } catch {}

    let toolCalls = [];
    try {
      toolCalls = db.prepare(
        `SELECT tc.*, t.created_at as turnTimestamp
         FROM tool_calls tc JOIN turns t ON t.id = tc.turn_id
         ORDER BY t.created_at DESC LIMIT 30`
      ).all();
    } catch (e) { console.error("toolCalls query error:", e.message); }

    let recentLogs = [];
    try {
      const logFile = path.join(AUTOMATON_DIR, "automaton.log");
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, "utf-8");
        recentLogs = content.split("\n").filter(Boolean).slice(-100);
      }
    } catch {}

    res.json({
      identity, turns, recentTurns, goals, toolCalls, recentLogs,
      walletAddress: identity.address || "unknown",
      name: identity.name || "unknown",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/goals", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all()); }
  catch { res.json([]); }
});

// ─── WebSocket ─────────────────────────────────────────────────
const wsClients = new Set();
wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  try { ws.send(JSON.stringify({ type: "identity", data: getIdentity() })); } catch {}
});

// ─── Live log tailing ──────────────────────────────────────────
function startLogTail() {
  const origLog = console.log;
  const origErr = console.error;
  const intercept = (stream) => (...args) => {
    const line = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    broadcastLog(line);
    stream(...args);
  };
  console.log = intercept(origLog);
  console.error = intercept(origErr);

  const logFile = path.join(AUTOMATON_DIR, "automaton.log");
  if (fs.existsSync(logFile)) {
    let lastSize = fs.statSync(logFile).size;
    setInterval(() => {
      try {
        const stat = fs.statSync(logFile);
        if (stat.size > lastSize) {
          const fd = fs.openSync(logFile, "r");
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);
          for (const line of buf.toString("utf-8").split("\n").filter(Boolean)) {
            broadcastLog(line);
          }
          lastSize = stat.size;
        }
      } catch {}
    }, 1000);
  }
}

// ─── Poll DB for changes ───────────────────────────────────────
let lastTurnCount = 0;
setInterval(() => {
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM turns").get();
    const count = row?.cnt || 0;
    if (count !== lastTurnCount) {
      lastTurnCount = count;
      broadcast({ type: "update" });

      // Check for new turns that might be responses to chat messages
      const latestTurn = db.prepare(
        `SELECT t.id, t.created_at as timestamp, t.thinking, tc.name, tc.result
         FROM turns t LEFT JOIN tool_calls tc ON tc.turn_id = t.id
         ORDER BY t.created_at DESC LIMIT 1`
      ).get();

      if (latestTurn) {
        broadcast({ type: "agent_response", turn: latestTurn });
      }
    }
  } catch {}
}, 2000);

// ─── Start ─────────────────────────────────────────────────────
startLogTail();

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} already in use. Kill with:`);
    console.error(`    taskkill /F /IM node.exe /T\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  Conway Automaton Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});
