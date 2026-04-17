// server.js — Express + WebSocket server
// Serves the dashboard and runs the trading bot.
// Deploy to Railway: set env vars TRADIER_PROD_TOKEN, TRADIER_PAPER_TOKEN, TRADIER_ACCOUNT_ID

'use strict';
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const store     = require('./store');
const trader    = require('./trader');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket broadcast ───────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// forward all bot events to connected clients
trader.emitter.on('update', ({ type, data }) => broadcast({ type, data }));

wss.on('connection', ws => {
  console.log('[ws] Client connected');
  // send full state snapshot on connect
  const s = store.get();
  ws.send(JSON.stringify({ type: 'snapshot', data: {
    openPositions:    s.openPositions,
    closedPositions:  s.closedPositions,
    pnlHistory:       s.pnlHistory,
    settings:         s.settings,
    watchlist:        s.watchlist,
    learnedThresholds:s.learnedThresholds,
    adaptationCount:  s.adaptationCount,
    tradeMemory:      s.tradeMemory,
    status:           trader.getStatus(),
    metrics:          trader.buildMetrics(),
    prices:           trader.priceCache,
  }}));
  ws.on('close', () => console.log('[ws] Client disconnected'));
});

// ── REST API ──────────────────────────────────────────────────────────────────

// Bot control
app.post('/api/bot/start',  (req, res) => { trader.start(); res.json({ ok: true, status: trader.getStatus() }); });
app.post('/api/bot/stop',   (req, res) => { trader.stop();  res.json({ ok: true, status: trader.getStatus() }); });
app.get( '/api/bot/status', (req, res) => res.json(trader.getStatus()));

// Settings
app.get('/api/settings', (req, res) => res.json(store.get().settings));
app.post('/api/settings', (req, res) => {
  store.setSettings(req.body);
  broadcast({ type: 'settings', data: store.get().settings });
  res.json({ ok: true });
});

// Watchlist
app.get('/api/watchlist', (req, res) => res.json(store.get().watchlist));
app.post('/api/watchlist/add', (req, res) => {
  const { sym } = req.body;
  if (!sym) return res.status(400).json({ error: 'sym required' });
  const wl = store.get().watchlist;
  if (!wl.includes(sym.toUpperCase())) store.set('watchlist', [...wl, sym.toUpperCase()]);
  broadcast({ type: 'watchlist', data: store.get().watchlist });
  res.json({ ok: true, watchlist: store.get().watchlist });
});
app.post('/api/watchlist/remove', (req, res) => {
  const { sym } = req.body;
  store.set('watchlist', store.get().watchlist.filter(s => s !== sym));
  broadcast({ type: 'watchlist', data: store.get().watchlist });
  res.json({ ok: true, watchlist: store.get().watchlist });
});

// Positions
app.get('/api/positions/open',   (req, res) => res.json(store.get().openPositions));
app.get('/api/positions/closed', (req, res) => res.json(store.get().closedPositions));
app.post('/api/positions/close/:id', async (req, res) => {
  const qty = req.body?.quantity || null;
  await trader.exitTrade(parseInt(req.params.id), 'manual', qty);
  res.json({ ok: true });
});

// Manual trade entry
app.post('/api/trade/enter', async (req, res) => {
  const { sym, direction } = req.body;
  if (!sym || !direction) return res.status(400).json({ error: 'sym and direction required' });
  await trader.enterTrade(sym, direction, 'manual');
  res.json({ ok: true });
});

// Account sync
app.post('/api/account/sync', async (req, res) => {
  const result = await trader.syncAccount();
  res.json({ ok: true, account: result });
});

// Metrics
app.get('/api/metrics', (req, res) => res.json(trader.buildMetrics()));

// P&L history
app.get('/api/pnl', (req, res) => res.json(store.get().pnlHistory));

// Learning engine
app.get('/api/learning', (req, res) => res.json({
  tradeMemory:       store.get().tradeMemory,
  learnedThresholds: store.get().learnedThresholds,
  adaptationCount:   store.get().adaptationCount,
}));
app.post('/api/learning/run', (req, res) => {
  trader.runLearningCycle();
  res.json({ ok: true, learnedThresholds: store.get().learnedThresholds });
});

// Signals
app.get('/api/signals', (req, res) => res.json(trader.signals));

// ML service proxy endpoints
app.get('/api/ml/status', async (req, res) => {
  const url = process.env.ML_SERVICE_URL;
  if (!url) return res.json({ enabled: false, message: 'ML_SERVICE_URL not set' });
  try {
    const r = await require('node-fetch')(`${url}/health`);
    const d = await r.json();
    res.json({ enabled: true, ...d });
  } catch(e) {
    res.json({ enabled: false, error: e.message });
  }
});

app.post('/api/ml/train', async (req, res) => {
  const url = process.env.ML_SERVICE_URL;
  if (!url) return res.status(400).json({ error: 'ML_SERVICE_URL not set' });
  try {
    const r = await require('node-fetch')(`${url}/train`, { method: 'POST' });
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ml/train/memory', async (req, res) => {
  const url = process.env.ML_SERVICE_URL;
  if (!url) return res.status(400).json({ error: 'ML_SERVICE_URL not set' });
  try {
    const tradeMemory = req.body.trade_memory || store.get().tradeMemory;
    const r = await require('node-fetch')(`${url}/train/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trade_memory: tradeMemory }),
    });
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ml/summary', async (req, res) => {
  const url = process.env.ML_SERVICE_URL;
  if (!url) return res.json({ enabled: false });
  try {
    const r = await require('node-fetch')(`${url}/summary`);
    const d = await r.json();
    res.json({ enabled: true, ...d });
  } catch(e) {
    res.json({ enabled: false, error: e.message });
  }
});

// Health check (Railway uses this)
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), time: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Directional Options Bot server running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Tradier prod token: ${process.env.TRADIER_PROD_TOKEN ? '✓ set' : '✗ MISSING'}`);
  console.log(`   Tradier paper token: ${process.env.TRADIER_PAPER_TOKEN ? '✓ set' : '✗ MISSING'}`);
  console.log(`   Account ID: ${process.env.TRADIER_ACCOUNT_ID ? '✓ set' : '✗ MISSING'}\n`);
  trader.init();
});

// ── Migration endpoint (one-time import from localStorage) ─────────────────
app.post('/api/migrate', (req, res) => {
  const { tradeMemory, learnedThresholds, adaptationCount, closedPositions, pnlHistory, watchlist } = req.body;
  if (tradeMemory)       store.set('tradeMemory',       tradeMemory);
  if (learnedThresholds) store.set('learnedThresholds', learnedThresholds);
  if (adaptationCount)   store.set('adaptationCount',   adaptationCount);
  if (closedPositions)   store.set('closedPositions',   closedPositions);
  if (pnlHistory)        store.set('pnlHistory',        pnlHistory);
  if (watchlist)         store.set('watchlist',         watchlist);
  broadcast({ type:'snapshot', data:{ ...store.get(), status:trader.getStatus(), metrics:trader.buildMetrics() } });
  console.log(`[migrate] Imported: ${tradeMemory?.length||0} trades, ${closedPositions?.length||0} closed positions`);
  res.json({ ok:true, imported:{ trades:tradeMemory?.length||0, closed:closedPositions?.length||0 } });
});
