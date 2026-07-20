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

    // Wake the agent to process the new message immediately
    try {
      db.prepare(
        `INSERT INTO wake_events (source, reason) VALUES (?, ?)`
      ).run('dashboard', 'New message from creator via chat');
    } catch (e) {
      console.warn("Wake event insert failed:", e.message);
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

// Agent-to-user messages from kv table
let lastAgentMsgCheck = 0;
app.get("/api/chat/agent-messages", (req, res) => {
  try {
    const since = parseInt(req.query.since || "0", 10);
    const rows = db.prepare(
      `SELECT key, value FROM kv WHERE key LIKE 'chat_response_%'`
    ).all();
    const messages = rows
      .map((r) => {
        try { return JSON.parse(r.value); } catch { return null; }
      })
      .filter((m) => m && m.ts > since)
      .sort((a, b) => a.ts - b.ts);
    res.json(messages);
  } catch (e) {
    res.json([]);
  }
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

// ─── Polymarket Simulator ──────────────────────────────────────
const polymarketState = {
  balance: 10000.00,
  signals: [
    { id: 1, market: "US Presidential Election 2026", recommendation: "BUY YES (Trump)", confidence: "87%", volume: "$14.2M", time: "Just now" },
    { id: 2, market: "Fed Interest Rate Cut in September", recommendation: "BUY NO (50bps)", confidence: "62%", volume: "$8.4M", time: "2m ago" },
    { id: 3, market: "US Inflation falls below 2.5% in Q3", recommendation: "BUY YES", confidence: "78%", volume: "$3.1M", time: "15m ago" },
    { id: 4, market: "Solana ETF approved in 2026", recommendation: "BUY YES", confidence: "54%", volume: "$11.9M", time: "1h ago" },
  ],
  positions: [
    { id: 1, market: "US Presidential Election 2026", contract: "YES", qty: 25000, avgPrice: "$0.54", currentPrice: "$0.59", pnl: "+$1,250.00 (+9.2%)", status: "open" },
    { id: 2, market: "Fed Interest Rate Cut in September", contract: "NO", qty: 10000, avgPrice: "$0.42", currentPrice: "$0.45", pnl: "+$300.00 (+7.1%)", status: "open" },
  ],
  logs: [
    { ts: Date.now() - 5000, type: "info", message: "[Polymarket] Signal detected: Sentiment index for US President exceeds 60%." },
    { ts: Date.now() - 25000, type: "trade", message: "[Polymarket] Executed BUY order: 5,000 Trump YES contracts at $0.58." },
    { ts: Date.now() - 120000, type: "info", message: "[Polymarket] Position updated: Fed cut NO contracts current price rose to $0.45." },
  ]
};

// Periodically update the simulator to make it dynamic
setInterval(() => {
  try {
    for (const pos of polymarketState.positions) {
      const curr = parseFloat(pos.currentPrice.replace("$", ""));
      const change = (Math.random() - 0.5) * 0.02;
      const next = Math.max(0.01, Math.min(0.99, curr + change)).toFixed(2);
      pos.currentPrice = `$${next}`;

      const avg = parseFloat(pos.avgPrice.replace("$", ""));
      const diff = (parseFloat(next) - avg) * pos.qty;
      const pct = ((parseFloat(next) - avg) / avg * 100).toFixed(1);
      pos.pnl = `${diff >= 0 ? "+" : ""}$${diff.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${diff >= 0 ? "+" : ""}${pct}%)`;
    }

    if (Math.random() > 0.8) {
      const markets = [
        "AI Safety Treaty signed in 2026",
        "Apple announces LLM agent for macOS",
        "SpaceX Starship orbital catch success",
        "Ethereum gas fees hit all-time low"
      ];
      const recs = ["BUY YES", "BUY NO"];
      const market = markets[Math.floor(Math.random() * markets.length)];
      const rec = recs[Math.floor(Math.random() * recs.length)];
      const conf = Math.floor(60 + Math.random() * 35) + "%";
      const vol = "$" + (Math.random() * 5 + 1).toFixed(1) + "M";

      polymarketState.signals.unshift({
        id: Date.now(),
        market,
        recommendation: rec,
        confidence: conf,
        volume: vol,
        time: "Just now"
      });
      if (polymarketState.signals.length > 5) polymarketState.signals.pop();

      polymarketState.logs.unshift({
        ts: Date.now(),
        type: "info",
        message: `[Polymarket] Signal detected: AI Agent identified trade opportunity on '${market}'.`
      });
      if (polymarketState.logs.length > 15) polymarketState.logs.pop();
    }
  } catch {}
}, 5000);

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

    let currentModel = "gpt-5-mini";
    try {
      const configPath = path.join(AUTOMATON_DIR, "automaton.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        currentModel = config.modelStrategy?.inferenceModel || "gpt-5-mini";
      }
    } catch {}

    res.json({
      identity, turns, recentTurns, goals, toolCalls, recentLogs,
      walletAddress: identity.address || "unknown",
      name: identity.name || "unknown",
      currentModel
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Model Selection API ───────────────────────────────────────
// List available free models from Ollama
app.get("/api/models", async (req, res) => {
  try {
    const http = require("http");
    const ollamaUrl = "http://localhost:11434/api/tags";
    const response = await new Promise((resolve, reject) => {
      http.get(ollamaUrl, { timeout: 5000 }, (resp) => {
        let data = "";
        resp.on("data", (chunk) => data += chunk);
        resp.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on("error", reject);
    });

    const models = (response.models || []).map(m => ({
      id: m.name,
      displayName: m.name,
      provider: "ollama",
      size: m.size,
      sizeGB: (m.size / (1024*1024*1024)).toFixed(1) + " GB",
      free: true,
    }));

    // Add built-in free models that might not be pulled yet
    const builtInFree = [
      { id: "llama3.3:8b", displayName: "Llama 3.3 8B", provider: "ollama", free: true },
      { id: "qwen3:8b", displayName: "Qwen3 8B", provider: "ollama", free: true },
      { id: "mimo-v2.5", displayName: "MiMo V2.5", provider: "ollama", free: true },
      { id: "nemotron-3-ultra", displayName: "Nemotron 3 Ultra", provider: "ollama", free: true },
      { id: "north-mini-code", displayName: "North Mini Code", provider: "ollama", free: true },
    ];

    // Merge: installed models first, then built-in that aren't installed
    const installedIds = new Set(models.map(m => m.id));
    for (const bi of builtInFree) {
      if (!installedIds.has(bi.id)) {
        models.push({ ...bi, installed: false });
      } else {
        const idx = models.findIndex(m => m.id === bi.id);
        if (idx >= 0) models[idx].displayName = bi.displayName;
      }
    }

    res.json({ models, ollamaRunning: true });
  } catch (e) {
    // Ollama not running - return built-in free models
    const builtInFree = [
      { id: "llama3.3:8b", displayName: "Llama 3.3 8B", provider: "ollama", free: true, installed: false },
      { id: "qwen3:8b", displayName: "Qwen3 8B", provider: "ollama", free: true, installed: false },
      { id: "mimo-v2.5", displayName: "MiMo V2.5", provider: "ollama", free: true, installed: false },
      { id: "nemotron-3-ultra", displayName: "Nemotron 3 Ultra", provider: "ollama", free: true, installed: false },
      { id: "north-mini-code", displayName: "North Mini Code", provider: "ollama", free: true, installed: false },
    ];
    res.json({ models: builtInFree, ollamaRunning: false });
  }
});

// Get current model
app.get("/api/model", (req, res) => {
  try {
    const configPath = path.join(AUTOMATON_DIR, "automaton.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      res.json({
        currentModel: config.modelStrategy?.inferenceModel || config.inferenceModel || "unknown",
        lowComputeModel: config.modelStrategy?.lowComputeModel || "unknown",
        ollamaUrl: config.ollamaBaseUrl || "not configured",
      });
    } else {
      res.json({ currentModel: "unknown", ollamaUrl: "not configured" });
    }
  } catch (e) {
    res.json({ currentModel: "unknown", error: e.message });
  }
});

// Switch model (updates config and restarts agent)
app.post("/api/model/switch", (req, res) => {
  try {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: "Model required" });

    const configPath = path.join(AUTOMATON_DIR, "automaton.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    config.inferenceModel = model;
    if (!config.modelStrategy) config.modelStrategy = {};
    config.modelStrategy.inferenceModel = model;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Store model switch event in KV
    try {
      db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .run("model_switch_request", JSON.stringify({ model, requestedAt: new Date().toISOString() }));
    } catch (e) { console.warn("KV write failed:", e.message); }

    broadcast({ type: "model_switch", model });
    res.json({ ok: true, model });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pull a model (downloads via Ollama)
app.post("/api/models/pull", (req, res) => {
  try {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: "Model name required" });

    const http = require("http");
    const postData = JSON.stringify({ name: model, stream: false });

    const ollamaReq = http.request("http://localhost:11434/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
      timeout: 300000,
    }, (resp) => {
      let data = "";
      resp.on("data", (chunk) => data += chunk);
      resp.on("end", () => {
        try { res.json(JSON.parse(data)); }
        catch { res.json({ status: "done" }); }
      });
    });

    ollamaReq.on("error", (e) => res.status(500).json({ error: e.message }));
    ollamaReq.write(postData);
    ollamaReq.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/goals", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all()); }
  catch { res.json([]); }
});

app.get("/api/polymarket", (req, res) => {
  res.json(polymarketState);
});

app.post("/api/polymarket/trade", (req, res) => {
  try {
    const { market, action, contract, qty, price } = req.body;
    if (!market || !action || !contract || !qty || !price) {
      return res.status(400).json({ error: "Missing required trade fields" });
    }

    const tradeQty = parseInt(qty, 10);
    const tradePrice = parseFloat(price);
    const totalCost = tradeQty * tradePrice;

    if (action === "buy") {
      if (polymarketState.balance < totalCost) {
        return res.status(400).json({ error: "Insufficient mock USD balance" });
      }
      polymarketState.balance -= totalCost;

      // Find or create position
      let pos = polymarketState.positions.find(p => p.market === market && p.contract === contract);
      if (pos) {
        const currentTotalCost = parseFloat(pos.avgPrice.replace("$", "")) * pos.qty;
        pos.qty += tradeQty;
        pos.avgPrice = `$${((currentTotalCost + totalCost) / pos.qty).toFixed(2)}`;
      } else {
        polymarketState.positions.push({
          id: Date.now(),
          market,
          contract,
          qty: tradeQty,
          avgPrice: `$${tradePrice.toFixed(2)}`,
          currentPrice: `$${tradePrice.toFixed(2)}`,
          pnl: "+$0.00 (+0.0%)",
          status: "open"
        });
      }
    } else if (action === "sell") {
      // Find position to sell
      let posIndex = polymarketState.positions.findIndex(p => p.market === market && p.contract === contract);
      if (posIndex === -1 || polymarketState.positions[posIndex].qty < tradeQty) {
        return res.status(400).json({ error: "Insufficient position contracts to sell" });
      }

      const pos = polymarketState.positions[posIndex];
      polymarketState.balance += totalCost;
      pos.qty -= tradeQty;

      if (pos.qty === 0) {
        polymarketState.positions.splice(posIndex, 1);
      } else {
        // Re-calculate P&L
        const curr = parseFloat(pos.currentPrice.replace("$", ""));
        const avg = parseFloat(pos.avgPrice.replace("$", ""));
        const diff = (curr - avg) * pos.qty;
        const pct = ((curr - avg) / avg * 100).toFixed(1);
        pos.pnl = `${diff >= 0 ? "+" : ""}$${diff.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${diff >= 0 ? "+" : ""}${pct}%)`;
      }
    }

    // Add record to execution ledger
    polymarketState.logs.unshift({
      ts: Date.now(),
      type: "trade",
      message: `[Polymarket] User Executed ${action.toUpperCase()} order: ${tradeQty.toLocaleString()} ${market} ${contract} contracts at $${tradePrice.toFixed(2)}.`
    });
    if (polymarketState.logs.length > 15) polymarketState.logs.pop();

    broadcast({ type: "update" });
    res.json({ ok: true, balance: polymarketState.balance, positions: polymarketState.positions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings/model", (req, res) => {
  try {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: "model parameter required" });

    const configPath = path.join(AUTOMATON_DIR, "automaton.json");
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch {}
    }

    config.modelStrategy = config.modelStrategy || {};
    config.modelStrategy.inferenceModel = model;
    config.modelStrategy.lowComputeModel = model;
    config.modelStrategy.criticalModel = model;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    res.json({ ok: true, model });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
