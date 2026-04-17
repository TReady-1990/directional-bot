// trader.js — core trading engine
// Runs on the server, completely independent of any browser session.
// Environment variables required:
//   TRADIER_PROD_TOKEN   — production API token (market data, options chains)
//   TRADIER_PAPER_TOKEN  — sandbox API token (order placement)
//   TRADIER_ACCOUNT_ID   — paper account ID (e.g. VA12345678)

'use strict';
const fetch = require('node-fetch');
const store = require('./store');

// ── API config ────────────────────────────────────────────────────────────────
const PROD_BASE  = 'https://api.tradier.com/v1';
const PAPER_BASE = 'https://sandbox.tradier.com/v1';

function prodHeaders()  { return { Authorization: `Bearer ${process.env.TRADIER_PROD_TOKEN}`,  Accept: 'application/json' }; }
function paperHeaders() { return { Authorization: `Bearer ${process.env.TRADIER_PAPER_TOKEN}`, Accept: 'application/json' }; }
function paperPost()    { return { ...paperHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }; }
function accountId()    { return process.env.TRADIER_ACCOUNT_ID; }

// ── Event emitter for broadcasting to WebSocket clients ───────────────────────
const EventEmitter = require('events');
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function broadcast(type, data) {
  emitter.emit('update', { type, data, ts: Date.now() });
}

function log(msg, type = 'scan') {
  const entry = { msg, type, time: new Date().toLocaleTimeString('en-US', { hour12: false }) };
  console.log(`[bot] [${type}] ${msg}`);
  broadcast('log', entry);
}

// ── Market hours (ET) ─────────────────────────────────────────────────────────
function getETTime() {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  // EDT (UTC-4): March-November, EST (UTC-5): November-March
  const month = now.getUTCMonth(); // 0=Jan, 11=Dec
  const isDST = month >= 2 && month <= 10;
  return new Date(utcMs + ((isDST ? -4 : -5) * 3600000));
}

function isMarketOpen() {
  const et  = getETTime();
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

function isInTradingWindow() {
  const filter = store.getSetting('timeFilt') || 0;
  if (!filter) return true;
  const et   = getETTime();
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= (570 + filter) && mins <= (960 - filter);
}

function etTimeStr() {
  const et = getETTime();
  return `${et.getHours()}:${String(et.getMinutes()).padStart(2,'0')} ET`;
}

// ── Price cache ───────────────────────────────────────────────────────────────
let priceCache = {};

async function fetchPrices() {
  const { watchlist } = store.get();
  if (!watchlist.length) return;
  const batches = [];
  for (let i = 0; i < watchlist.length; i += 10) batches.push(watchlist.slice(i, i + 10));
  try {
    const results = await Promise.all(batches.map(async b => {
      const res  = await fetch(`${PROD_BASE}/markets/quotes?symbols=${b.join(',')}`, { headers: prodHeaders() });
      const data = await res.json();
      const raw  = data?.quotes?.quote;
      return raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    }));
    results.flat().forEach(q => {
      priceCache[q.symbol] = {
        price:    q.last || q.close || 0,
        prevClose:q.prevclose || 0,
        chg:      q.change || 0,
        chgPct:   q.change_percentage || 0,
        volume:   q.volume || 0,
        avgVol:   q.average_volume || q.volume || 1,
      };
    });
    broadcast('prices', priceCache);
    return true;
  } catch(e) {
    log(`Price fetch error: ${e.message}`, 'err');
    return false;
  }
}

// ── Signal generation ─────────────────────────────────────────────────────────
let signals = {};

function generateSignals() {
  const { watchlist, settings, learnedThresholds: lt } = store.get();
  const s = settings;

  watchlist.forEach(sym => {
    const q = priceCache[sym];
    if (!q || !q.price) { signals[sym] = null; return; }

    const rsi       = simulateRSI(sym, q);
    const baseIv    = { SPY:16, QQQ:18 }[sym] || 30;
    const ivRank    = Math.min(99, Math.max(5, baseIv + (Math.random() * 18 - 9)));
    const volSpike  = q.volume / (q.avgVol || 1);

    const conditions = {
      momentum: { met: Math.abs(q.chgPct) >= (lt.momentum || s.momentum), value: `${q.chgPct >= 0 ? '+' : ''}${q.chgPct.toFixed(2)}%`, label: 'Momentum', bullish: q.chgPct > 0, bearish: q.chgPct < 0 },
      rsi:      { met: rsi <= (lt.rsiLow || s.rsiLow) || rsi >= (lt.rsiHigh || s.rsiHigh), value: rsi.toFixed(0), label: 'RSI', bullish: rsi <= (lt.rsiLow || s.rsiLow), bearish: rsi >= (lt.rsiHigh || s.rsiHigh) },
      iv:       { met: ivRank <= (lt.ivMax || s.ivMax), value: `IV ${ivRank.toFixed(0)}`, label: 'IV Rank', bullish: true, bearish: true },
      volume:   { met: volSpike >= (lt.volMult || s.volMult), value: `${volSpike.toFixed(1)}×`, label: 'Volume', bullish: true, bearish: true },
    };

    const metCount  = Object.values(conditions).filter(c => c.met).length;
    const bullScore = ['momentum','rsi'].filter(k => conditions[k].met && conditions[k].bullish).length;
    const bearScore = ['momentum','rsi'].filter(k => conditions[k].met && conditions[k].bearish).length;
    const minCond   = lt.minCond || s.minCond;

    let direction = 'none';
    if (metCount >= minCond) {
      if (bullScore > bearScore)      direction = 'call';
      else if (bearScore > bullScore) direction = 'put';
      else if (bullScore > 0)         direction = q.chgPct > 0 ? 'call' : 'put';
    }

    // ticker bias from learning engine
    const bias = getTickerBias(sym);
    if (bias < -0.3 && direction !== 'none') {
      log(`Signal suppressed for ${sym} — negative bias (${(bias*100).toFixed(0)}%)`, 'scan');
      direction = 'none';
    }

    signals[sym] = { sym, price: q.price, chgPct: q.chgPct, chg: q.chg, rsi, ivRank, volSpike, conditions, metCount, direction };
  });

  broadcast('signals', signals);
}

function simulateRSI(sym, q) {
  const base = 50, momentumBias = q.chgPct * 3, noise = (Math.random() * 16) - 8;
  return Math.min(95, Math.max(5, base + momentumBias + noise));
}

function getTickerBias(sym) {
  const { tradeMemory } = store.get();
  const trades = tradeMemory.filter(t => t.sym === sym);
  if (trades.length < 3) return 0;
  return trades.filter(t => t.win).length / trades.length - 0.5;
}

// ── Options chain ─────────────────────────────────────────────────────────────
async function fetchBestContract(sym, direction) {
  const dte    = store.getSetting('dte') || 3;
  const delta  = store.getSetting('delta') || 0.65;
  const today  = new Date();

  // expirations
  const expRes  = await fetch(`${PROD_BASE}/markets/options/expirations?symbol=${sym}&includeAllRoots=false`, { headers: prodHeaders() });
  const expData = await expRes.json();
  const rawDates = expData?.expirations?.date;
  if (!rawDates) throw new Error(`No expirations for ${sym}`);
  const dates = Array.isArray(rawDates) ? rawDates : [rawDates];

  const validDates = dates
    .map(d => ({ date: d, dte: Math.round((new Date(d) - today) / 86400000) }))
    .filter(d => d.dte >= 1 && d.dte <= 5)
    .sort((a, b) => Math.abs(a.dte - dte) - Math.abs(b.dte - dte));

  if (!validDates.length) throw new Error(`No 1–5 DTE expirations for ${sym}`);
  const { date: expiry, dte: actualDte } = validDates[0];

  // chain
  const chainRes  = await fetch(`${PROD_BASE}/markets/options/chains?symbol=${sym}&expiration=${expiry}&greeks=true`, { headers: prodHeaders() });
  const chainData = await chainRes.json();
  const rawChain  = chainData?.options?.option;
  if (!rawChain) throw new Error(`Empty chain for ${sym} ${expiry}`);
  const chain = Array.isArray(rawChain) ? rawChain : [rawChain];

  const price   = priceCache[sym]?.price || 0;
  const optType = direction === 'call' ? 'call' : 'put';

  const opts = chain.filter(o => o.option_type === optType && o.bid > 0 && o.greeks?.delta != null);
  if (!opts.length) throw new Error(`No valid ${optType}s for ${sym} ${expiry}`);

  opts.sort((a, b) =>
    Math.abs(Math.abs(a.greeks.delta) - delta) -
    Math.abs(Math.abs(b.greeks.delta) - delta)
  );

  const best = opts[0];
  const mid  = +((best.bid + best.ask) / 2).toFixed(2);

  return { optionSymbol: best.symbol, strike: best.strike, expiry, dte: actualDte, bid: best.bid, ask: best.ask, mid, delta: +Math.abs(best.greeks.delta).toFixed(2), direction };
}

// ── Order execution ───────────────────────────────────────────────────────────
async function placeBuyOrder(sym, contract, qty = 1) {
  const body = new URLSearchParams({
    class: 'option', symbol: sym, option_symbol: contract.optionSymbol,
    side: 'buy_to_open', quantity: String(qty),
    type: 'limit', price: contract.mid.toFixed(2), duration: 'day',
  });
  const res  = await fetch(`${PAPER_BASE}/accounts/${accountId()}/orders`, { method: 'POST', headers: paperPost(), body });
  const data = await res.json();
  if (data?.order?.id) return String(data.order.id);
  throw new Error(data?.errors?.error || data?.fault?.faultstring || JSON.stringify(data));
}

async function placeSellOrder(p, qty = null) {
  const qRes  = await fetch(`${PROD_BASE}/markets/quotes?symbols=${p.optionSymbol}`, { headers: prodHeaders() });
  const qData = await qRes.json();
  const q     = qData?.quotes?.quote;
  const mid   = q ? +((q.bid + q.ask) / 2).toFixed(2) : p.currValue;

  const body = new URLSearchParams({
    class: 'option', symbol: p.sym, option_symbol: p.optionSymbol,
    side: 'sell_to_close', quantity: String(qty || p.quantity || 1),
    type: 'limit', price: mid.toFixed(2), duration: 'day',
  });
  const res  = await fetch(`${PAPER_BASE}/accounts/${accountId()}/orders`, { method: 'POST', headers: paperPost(), body });
  const data = await res.json();
  if (data?.order?.id) return { closeOrderId: String(data.order.id), closePrice: mid };
  throw new Error(data?.errors?.error || data?.fault?.faultstring || JSON.stringify(data));
}

async function cancelOrder(orderId) {
  await fetch(`${PAPER_BASE}/accounts/${accountId()}/orders/${orderId}`, { method: 'DELETE', headers: paperHeaders() });
}

async function getOrderStatus(orderId) {
  const res  = await fetch(`${PAPER_BASE}/accounts/${accountId()}/orders/${orderId}`, { headers: paperHeaders() });
  const data = await res.json();
  return data?.order;
}

// ── Cooldown tracking ─────────────────────────────────────────────────────────
const cooldownMap = {};

// ── Risk state ────────────────────────────────────────────────────────────────
// Tracks live account data for pre-trade risk checks
let liveAccountCache = { equity: 0, cash: 0, obp: 0, dayPnl: 0, dayStartEquity: 0, lastFetched: 0 };

async function fetchAccountForRisk() {
  // cache for 30s to avoid hammering the API
  if (Date.now() - liveAccountCache.lastFetched < 30000) return liveAccountCache;
  try {
    const res  = await fetch(`${PAPER_BASE}/accounts/${accountId()}/balances`, { headers: paperHeaders() });
    const data = await res.json();
    const b    = data?.balances;
    if (!b) return liveAccountCache;
    const equity = b.total_equity || 0;
    // set day start equity once per day (first fetch after midnight ET)
    const et    = getETTime();
    const isNewDay = et.getHours() < 1;
    if (isNewDay || liveAccountCache.dayStartEquity === 0) {
      liveAccountCache.dayStartEquity = equity;
    }
    liveAccountCache = {
      equity,
      cash:            b.total_cash          || 0,
      obp:             b.option_buying_power || b.buying_power || 0,
      dayPnl:          b.day_change          || 0,
      dayStartEquity:  liveAccountCache.dayStartEquity || equity,
      lastFetched:     Date.now(),
    };
    broadcast('account', liveAccountCache);
    return liveAccountCache;
  } catch(e) {
    log(`Risk account fetch error: ${e.message}`, 'err');
    return liveAccountCache;
  }
}

// Returns null if trade is allowed, or a rejection reason string
async function checkRiskGates(contract, quantity) {
  const s   = store.get().settings;
  const acct = await fetchAccountForRisk();

  // ── 1. Buying power check ──────────────────────────────────────────────────
  const orderCost = contract.mid * 100 * quantity; // options are ×100
  if (acct.obp > 0 && orderCost > acct.obp) {
    return `Insufficient buying power — order costs $${orderCost.toFixed(0)}, available $${acct.obp.toFixed(0)}`;
  }

  // ── 2. Max risk per trade ──────────────────────────────────────────────────
  const maxRiskPct = (s.maxRiskPerTrade || 10) / 100;
  const maxRiskDollar = acct.equity * maxRiskPct;
  if (acct.equity > 0 && orderCost > maxRiskDollar) {
    return `Max risk per trade exceeded — order costs $${orderCost.toFixed(0)}, max allowed $${maxRiskDollar.toFixed(0)} (${s.maxRiskPerTrade || 10}% of $${acct.equity.toFixed(0)})`;
  }

  // ── 3. Max daily loss ──────────────────────────────────────────────────────
  const maxDailyLossPct = (s.maxDailyLoss || 5) / 100;
  const maxDailyLossDollar = acct.dayStartEquity * maxDailyLossPct;
  const todayLoss = acct.dayStartEquity - acct.equity;
  if (todayLoss > 0 && todayLoss >= maxDailyLossDollar) {
    return `Daily loss limit hit — down $${todayLoss.toFixed(0)} today (limit: $${maxDailyLossDollar.toFixed(0)} / ${s.maxDailyLoss || 5}% of account). Bot paused for the day.`;
  }

  // ── 4. Max total exposure ──────────────────────────────────────────────────
  const maxExposurePct = (s.maxExposure || 30) / 100;
  const maxExposureDollar = acct.equity * maxExposurePct;
  const { openPositions } = store.get();
  const currentExposure = openPositions
    .filter(p => p.orderStatus === 'filled')
    .reduce((sum, p) => sum + (p.costBasis * 100 * (p.quantity || 1)), 0);
  const newExposure = currentExposure + orderCost;
  if (acct.equity > 0 && newExposure > maxExposureDollar) {
    return `Max exposure limit — current $${currentExposure.toFixed(0)} + new $${orderCost.toFixed(0)} = $${newExposure.toFixed(0)}, limit $${maxExposureDollar.toFixed(0)} (${s.maxExposure || 30}% of account)`;
  }

  return null; // all checks passed
}

// Daily loss check — call this before each scan to halt trading if limit hit
async function isDailyLossLimitHit() {
  const s    = store.get().settings;
  const acct = await fetchAccountForRisk();
  if (!acct.dayStartEquity || !acct.equity) return false;
  const loss    = acct.dayStartEquity - acct.equity;
  const maxLoss = acct.dayStartEquity * ((s.maxDailyLoss || 5) / 100);
  return loss >= maxLoss;
}

function isOnCooldown(sym) {
  const ts = cooldownMap[sym];
  if (!ts) return false;
  const cooldownMs = (store.getSetting('cooldown') || 15) * 60 * 1000;
  if (Date.now() - ts < cooldownMs) return true;
  delete cooldownMap[sym];
  return false;
}

// ── Enter trade ───────────────────────────────────────────────────────────────
async function enterTrade(sym, direction, source = 'auto') {
  const { openPositions } = store.get();
  if (openPositions.some(p => p.sym === sym && p.orderStatus !== 'cancelled')) return;

  const sig      = signals[sym];
  const quantity = (sig && sig.metCount >= 4) ? 2 : 1;
  if (quantity === 2) log(`${sym} — all 4 conditions met, scaling in with 2 contracts`, 'order');

  let contract, orderId;
  try {
    log(`Fetching ${direction.toUpperCase()} chain for ${sym}...`, 'order');
    contract = await fetchBestContract(sym, direction);
    log(`Contract: ${contract.optionSymbol} · Δ${contract.delta} · mid $${contract.mid} · ${contract.dte}DTE · qty ${quantity}`, 'order');

    // ── pre-trade risk checks ──────────────────────────────────────────────
    const rejection = await checkRiskGates(contract, quantity);
    if (rejection) {
      log(`RISK GATE BLOCKED — ${sym}: ${rejection}`, 'err');
      broadcast('risk', { sym, reason: rejection, ts: Date.now() });
      return;
    }

    orderId = await placeBuyOrder(sym, contract, quantity);
    log(`ORDER #${orderId} — buy to open ${direction.toUpperCase()} ${quantity}x ${contract.optionSymbol} @ $${contract.mid}`, direction === 'call' ? 'call' : 'put');
  } catch(e) {
    log(`Order failed for ${sym}: ${e.message}`, 'err');
    return;
  }

  const entrySnapshot = sig ? {
    momentum: sig.conditions.momentum.met, rsi: sig.conditions.rsi.met,
    iv: sig.conditions.iv.met, volume: sig.conditions.volume.met,
    rsiVal: sig.rsi, ivRank: sig.ivRank, volSpike: sig.volSpike,
    chgPct: sig.chgPct, metCount: sig.metCount,
  } : {};

  const pos = {
    id:           Date.now(),
    sym, direction,
    optionSymbol: contract.optionSymbol,
    orderId, orderStatus: 'pending',
    limitPrice:   contract.mid,
    strike:       contract.strike,
    expiry:       contract.expiry,
    dte:          contract.dte,
    costBasis:    contract.mid,
    currValue:    contract.mid,
    quantity,
    peakValue:    contract.mid,
    partialClosed:false,
    entryPrice:   priceCache[sym]?.price || 0,
    source,
    openedAt:     new Date().toLocaleTimeString(),
    openedAtMs:   Date.now(),
    entrySnapshot,
  };

  store.update('openPositions', arr => [...arr, pos]);
  if (source === 'auto') store.set('autoCount', (store.get().autoCount || 0) + 1);

  broadcast('positions', store.get().openPositions);
  broadcast('metrics', buildMetrics());
}

// ── Exit trade ────────────────────────────────────────────────────────────────
// Places a sell_to_close order and marks position as 'closing'.
// checkFillsAndRisk() polls Tradier every 30s and completes the close
// when the actual fill is confirmed — using the real fill price.
async function exitTrade(id, reason, manualQty = null) {
  const { openPositions } = store.get();
  const idx = openPositions.findIndex(p => p.id === id);
  if (idx === -1) return;
  const p = openPositions[idx];

  // already closing — don't double-submit
  if (p.orderStatus === 'closing') {
    log(`${p.sym} already has a close order pending (#${p.closeOrderId})`, 'scan');
    return;
  }

  // pending open order — cancel it instead
  if (p.orderStatus === 'pending' && p.orderId) {
    try { await cancelOrder(p.orderId); log(`Cancelled pending order #${p.orderId} for ${p.sym}`, 'scan'); }
    catch(e) { log(`Cancel failed #${p.orderId}: ${e.message}`, 'err'); }
    store.update('openPositions', arr => arr.filter(x => x.id !== id));
    broadcast('positions', store.get().openPositions);
    broadcast('metrics', buildMetrics());
    return;
  }

  // determine how many contracts to close
  const totalQty  = p.quantity || 1;
  const closeQty  = manualQty && manualQty < totalQty ? manualQty : totalQty;
  const isPartial = closeQty < totalQty;

  // place the sell order
  let closeOrderId = null;
  let limitPrice   = p.currValue;
  try {
    const result = await placeSellOrder(p, closeQty);
    closeOrderId = result.closeOrderId;
    limitPrice   = result.closePrice;
    log(`CLOSE ORDER #${closeOrderId} placed — sell to close ${closeQty}x ${p.optionSymbol} @ $${limitPrice} limit · ${reason}`, 'close');
  } catch(e) {
    log(`Close order failed for ${p.sym}: ${e.message}`, 'err');
    return;
  }

  if (isPartial) {
    // for partial closes track the close order on the position but keep it open
    store.update('openPositions', arr => arr.map(x => x.id === id
      ? { ...x, orderStatus: 'closing-partial', closeOrderId, closeQty, closeReason: reason, closingAt: Date.now() }
      : x));
    log(`Waiting for partial close fill on ${p.sym} — ${closeQty}/${totalQty} contracts`, 'scan');
  } else {
    // full close — mark as closing, keep in open list until fill confirmed
    store.update('openPositions', arr => arr.map(x => x.id === id
      ? { ...x, orderStatus: 'closing', closeOrderId, closeReason: reason, closingAt: Date.now() }
      : x));
    log(`Waiting for close fill on ${p.sym} — order #${closeOrderId}`, 'scan');
  }

  broadcast('positions', store.get().openPositions);
  broadcast('metrics',   buildMetrics());
}

// ── Finalize a confirmed close fill ───────────────────────────────────────────
function finalizeClose(p, fillPrice, isPartial, closeQty) {
  const id     = p.id;
  const pnl    = +(fillPrice - p.costBasis).toFixed(2);
  const pnlPct = p.costBasis ? +((pnl / p.costBasis) * 100).toFixed(1) : 0;

  if (isPartial) {
    const remaining = (p.quantity || 1) - closeQty;
    store.update('openPositions', arr => arr.map(x => x.id === id
      ? { ...x, orderStatus: 'filled', quantity: remaining, partialClosed: true,
          closeOrderId: null, closeReason: null, closingAt: null }
      : x));
    log(`PARTIAL CLOSE FILLED — ${p.sym} ${closeQty} contracts @ $${fillPrice.toFixed(2)} · P&L ${pnl>=0?'+':''}$${(pnl*100*closeQty).toFixed(0)} · ${remaining} remaining`, 'fill');
    broadcast('positions', store.get().openPositions);
    broadcast('metrics',   buildMetrics());
    return;
  }

  // full close confirmed
  const closed = { ...p, closePrice: fillPrice, pnl, pnlPct, win: pnl >= 0,
    closedAt: new Date().toLocaleTimeString(), closeReason: p.closeReason || 'manual' };

  store.update('openPositions',   arr => arr.filter(x => x.id !== id));
  store.update('closedPositions', arr => [closed, ...arr]);

  const cumPnl = store.get().closedPositions.reduce((s, t) => s + (t.pnl || 0), 0);
  store.update('pnlHistory', arr => [...arr, { label: '#' + store.get().closedPositions.length, value: +cumPnl.toFixed(2), win: pnl >= 0 }]);

  log(`${p.sym} ${p.direction.toUpperCase()} CLOSE CONFIRMED @ $${fillPrice.toFixed(2)} · P&L ${pnl>=0?'+':''}$${(pnl*100).toFixed(0)}/contract (${pnl>=0?'+':''}${pnlPct}%) · ${closed.closeReason}`, pnl>=0?'fill':'err');

  recordTradeForLearning({ ...closed });
  broadcast('positions',  store.get().openPositions);
  broadcast('closed',     store.get().closedPositions);
  broadcast('pnlHistory', store.get().pnlHistory);
  broadcast('metrics',    buildMetrics());
}

// ── Fill checker & risk monitor ───────────────────────────────────────────────
async function checkFillsAndRisk() {
  const s            = store.get().settings;
  const profitTarget = s.profitTarget / 100;
  const stopLoss     = s.stopLoss     / 100;
  const trailPct     = s.trailPct     / 100;
  const trailDollar  = s.trailDollar;

  // 0 — check closing orders (sell_to_close awaiting fill)
  const closing = store.get().openPositions.filter(p =>
    (p.orderStatus === 'closing' || p.orderStatus === 'closing-partial') && p.closeOrderId
  );
  for (const p of closing) {
    try {
      const order = await getOrderStatus(p.closeOrderId);
      if (!order) continue;
      const isPartial = p.orderStatus === 'closing-partial';

      if (order.status === 'filled') {
        const fillPrice = +(order.avg_fill_price || p.currValue);
        log(`CLOSE FILL CONFIRMED — ${p.sym} #${p.closeOrderId} @ $${fillPrice.toFixed(2)}`, 'fill');
        finalizeClose(p, fillPrice, isPartial, p.closeQty || p.quantity || 1);

      } else if (order.status === 'canceled' || order.status === 'rejected') {
        // close order failed — revert position to filled so user can try again
        log(`CLOSE ORDER ${order.status.toUpperCase()} — ${p.sym} #${p.closeOrderId} · position reverted to open`, 'err');
        store.update('openPositions', arr => arr.map(x => x.id === p.id
          ? { ...x, orderStatus: 'filled', closeOrderId: null, closeReason: null, closingAt: null }
          : x));
        broadcast('positions', store.get().openPositions);
        broadcast('risk', { reason: `Close order ${order.status} for ${p.sym} — position is still open. Please try closing again.`, ts: Date.now() });

      } else {
        // still pending — check for timeout (10 minutes)
        const closingMs = Date.now() - (p.closingAt || Date.now());
        if (closingMs > 10 * 60 * 1000) {
          log(`CLOSE TIMEOUT — ${p.sym} #${p.closeOrderId} unfilled after 10 min · cancelling and reverting`, 'err');
          try { await cancelOrder(p.closeOrderId); } catch(e) { /* ignore */ }
          store.update('openPositions', arr => arr.map(x => x.id === p.id
            ? { ...x, orderStatus: 'filled', closeOrderId: null, closeReason: null, closingAt: null }
            : x));
          broadcast('positions', store.get().openPositions);
          broadcast('risk', { reason: `Close order timed out for ${p.sym} after 10 min — position reverted to open. Market may have moved away from limit price.`, ts: Date.now() });
        } else {
          log(`Waiting for close fill on ${p.sym} — order #${p.closeOrderId} (${Math.round(closingMs/60000)}min)`, 'scan');
        }
      }
    } catch(e) { log(`Close order check error ${p.sym}: ${e.message}`, 'err'); }
  }

  // 1 — pending order fills
  const pending = store.get().openPositions.filter(p => p.orderStatus === 'pending' && p.orderId);
  for (const p of pending) {
    try {
      const order = await getOrderStatus(p.orderId);
      if (!order) continue;
      if (order.status === 'filled') {
        const fillPrice = +(order.avg_fill_price || p.limitPrice);
        store.update('openPositions', arr => arr.map(x => x.id === p.id
          ? { ...x, orderStatus: 'filled', costBasis: fillPrice, currValue: fillPrice, peakValue: fillPrice }
          : x));
        log(`FILLED ${p.sym} ${p.direction.toUpperCase()} @ $${fillPrice.toFixed(2)} · qty ${p.quantity} · #${p.orderId}`, 'fill');
        broadcast('positions', store.get().openPositions);
        broadcast('metrics',   buildMetrics());
      } else if (order.status === 'canceled' || order.status === 'rejected') {
        log(`ORDER ${order.status.toUpperCase()} — ${p.sym}`, 'err');
        store.update('openPositions', arr => arr.filter(x => x.id !== p.id));
        broadcast('positions', store.get().openPositions);
      } else if (Date.now() - p.openedAtMs > (s.fillTimeout || 3) * 60 * 1000) {
        await cancelOrder(p.orderId);
        log(`TIMEOUT — cancelled #${p.orderId} for ${p.sym}`, 'scan');
        store.update('openPositions', arr => arr.filter(x => x.id !== p.id));
        broadcast('positions', store.get().openPositions);
      }
    } catch(e) { log(`Fill check error ${p.sym}: ${e.message}`, 'err'); }
  }

  // 2 — update live quotes
  const filled = store.get().openPositions.filter(p => p.orderStatus === 'filled' && !p.optionSymbol?.includes('SIM'));
  if (filled.length) {
    try {
      const syms  = filled.map(p => p.optionSymbol).join(',');
      const qRes  = await fetch(`${PROD_BASE}/markets/quotes?symbols=${syms}`, { headers: prodHeaders() });
      const qData = await qRes.json();
      const rawQ  = qData?.quotes?.quote;
      const quotes = !rawQ ? [] : (Array.isArray(rawQ) ? rawQ : [rawQ]);
      store.update('openPositions', arr => arr.map(pos => {
        const q = quotes.find(x => x.symbol === pos.optionSymbol);
        if (!q || pos.orderStatus !== 'filled') return pos;
        const mid  = q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : (q.last || pos.currValue);
        const curr = +mid.toFixed(2);
        const peak = curr > (pos.peakValue || pos.costBasis) ? curr : (pos.peakValue || pos.costBasis);
        return { ...pos, currValue: curr, peakValue: peak, dte: q.days_to_expiration ?? pos.dte };
      }));
      broadcast('positions', store.get().openPositions);
      broadcast('metrics',   buildMetrics());
    } catch(e) { /* keep last values */ }
  }

  // 3 — risk checks (skip positions already being closed)
  for (const p of [...store.get().openPositions.filter(p => p.orderStatus === 'filled')]) {
    const pnlPct       = (p.currValue - p.costBasis) / p.costBasis;
    const peak         = p.peakValue || p.costBasis;
    const dropFromPeak = (peak - p.currValue) / peak;
    const dropDollar   = peak - p.currValue;
    const isProfit     = p.currValue > p.costBasis;

    // trailing stop
    const trailHit = isProfit && ((trailPct > 0 && dropFromPeak >= trailPct) || (trailDollar > 0 && dropDollar >= trailDollar));
    if (trailHit) {
      log(`TRAILING STOP — ${p.sym} peak $${peak.toFixed(2)} → $${p.currValue.toFixed(2)} (${(dropFromPeak*100).toFixed(1)}% drop)`, 'close');
      await exitTrade(p.id, 'trailing stop'); continue;
    }

    // partial close at profit target (2-contract positions only)
    if (!p.partialClosed && pnlPct >= profitTarget && (p.quantity || 1) > 1) {
      const closeQty = Math.floor((p.quantity || 1) / 2);
      log(`PARTIAL CLOSE — ${p.sym} hit ${(pnlPct*100).toFixed(1)}% · closing ${closeQty} of ${p.quantity} contracts`, 'fill');
      try {
        const result = await placeSellOrder(p, closeQty);
        log(`PARTIAL CLOSE ORDER #${result.closeOrderId} · ${closeQty} contracts @ $${result.closePrice}`, 'fill');
        store.update('openPositions', arr => arr.map(x => x.id === p.id
          ? { ...x, partialClosed: true, quantity: (x.quantity || 1) - closeQty }
          : x));
        broadcast('positions', store.get().openPositions);
      } catch(e) { log(`Partial close failed: ${e.message}`, 'err'); }
      continue;
    }

    // full profit target
    if (!p.partialClosed && pnlPct >= profitTarget) {
      log(`PROFIT TARGET — ${p.sym} ${p.direction.toUpperCase()} +${(pnlPct*100).toFixed(1)}%`, 'fill');
      await exitTrade(p.id, 'profit target'); continue;
    }

    // stop loss
    if (pnlPct <= -stopLoss) {
      log(`STOP LOSS — ${p.sym} ${p.direction.toUpperCase()} ${(pnlPct*100).toFixed(1)}%`, 'err');
      cooldownMap[p.sym] = Date.now();
      log(`Cooldown started for ${p.sym} — ${s.cooldown} min`, 'scan');
      await exitTrade(p.id, 'stop loss'); continue;
    }
  }
}

// ── Account sync ──────────────────────────────────────────────────────────────
async function syncAccount() {
  if (!process.env.TRADIER_PAPER_TOKEN || !accountId()) return null;
  // force refresh the risk cache and return the result
  liveAccountCache.lastFetched = 0;
  return await fetchAccountForRisk();
}

// ── Main scan loop ────────────────────────────────────────────────────────────
let scanLock = false;

async function runScan() {
  if (scanLock) { log('Scan skipped — previous scan running', 'scan'); return; }
  if (!isMarketOpen())      { log(`Market closed (${etTimeStr()}) — waiting for open`, 'scan'); return; }
  if (!isInTradingWindow()) { log(`Time filter active — no entries within ${store.getSetting('timeFilt')} min of open/close (${etTimeStr()})`, 'scan'); return; }
  if (await isDailyLossLimitHit()) {
    const s = store.get().settings;
    log(`DAILY LOSS LIMIT HIT — bot paused for the day. Limit: ${s.maxDailyLoss || 5}% of account. No new entries until tomorrow.`, 'err');
    broadcast('risk', { reason: 'Daily loss limit hit — trading paused for the day', ts: Date.now() });
    return;
  }

  scanLock = true;
  try {
    const maxPos = store.getSetting('maxPositions') || 3;
    const { openPositions } = store.get();
    if (openPositions.length >= maxPos) {
      log(`${openPositions.length}/${maxPos} max positions — skipping entry scan`, 'scan'); return;
    }
    await fetchPrices();
    generateSignals();

    for (const sym of store.get().watchlist) {
      const { openPositions: current } = store.get();
      if (current.length >= maxPos) break;
      const sig = signals[sym];
      if (!sig || sig.direction === 'none') continue;
      if (current.some(p => p.sym === sym && p.orderStatus !== 'cancelled')) continue;
      if (isOnCooldown(sym)) {
        const rem = Math.ceil(((store.getSetting('cooldown') || 15) * 60000 - (Date.now() - cooldownMap[sym])) / 60000);
        log(`${sym} on cooldown — ${rem} min remaining`, 'scan');
        continue;
      }
      await enterTrade(sym, sig.direction, 'auto');
      await new Promise(r => setTimeout(r, 500));
    }
  } finally { scanLock = false; }
}

// ── Learning engine ───────────────────────────────────────────────────────────
const DEFAULT_THRESHOLDS = { momentum: 0.5, rsiLow: 35, rsiHigh: 65, ivMax: 35, volMult: 1.5, minCond: 3 };
const THRESHOLD_BOUNDS   = { momentum:{min:0.1,max:3.0}, rsiLow:{min:20,max:45}, rsiHigh:{min:55,max:80}, ivMax:{min:10,max:55}, volMult:{min:1.0,max:4.0}, minCond:{min:2,max:4} };

function recordTradeForLearning(trade) {
  if (!trade.entrySnapshot) return;
  store.update('tradeMemory', arr => [{
    sym: trade.sym, direction: trade.direction, win: trade.win,
    pnl: trade.pnl, pnlPct: trade.pnlPct, closeReason: trade.closeReason,
    snapshot: trade.entrySnapshot, closedAt: Date.now(),
    costBasis: trade.costBasis, closePrice: trade.closePrice, entryPrice: trade.entryPrice,
  }, ...arr.slice(0, 199)]);

  const { tradeMemory } = store.get();
  if (tradeMemory.length % 5 === 0) runLearningCycle();
}

function runLearningCycle() {
  const { tradeMemory, learnedThresholds } = store.get();
  if (tradeMemory.length < 5) return;

  const thresh = { ...learnedThresholds };
  let changed = 0;
  const findings = [];

  // RSI adaptation
  const rsiTrades = tradeMemory.filter(t => t.snapshot?.rsiVal != null);
  if (rsiTrades.length >= 5) {
    const bins = {};
    rsiTrades.forEach(t => {
      const bin = Math.floor(t.snapshot.rsiVal / 5) * 5;
      if (!bins[bin]) bins[bin] = { wins: 0, total: 0 };
      bins[bin].wins += t.win ? 1 : 0;
      bins[bin].total++;
    });
    const lowBins = Object.entries(bins).filter(([b]) => parseInt(b) <= 45);
    if (lowBins.length >= 2) {
      const best = lowBins.reduce((b, [bin, s]) => s.total >= 2 && s.wins/s.total > b.wr ? {bin:parseInt(bin),wr:s.wins/s.total} : b, {bin:35,wr:0});
      if (Math.abs(best.bin - thresh.rsiLow) >= 5) {
        const adj = best.bin < thresh.rsiLow ? -2 : 2;
        thresh.rsiLow = Math.max(THRESHOLD_BOUNDS.rsiLow.min, Math.min(THRESHOLD_BOUNDS.rsiLow.max, thresh.rsiLow + adj));
        changed++; findings.push(`RSI oversold threshold → ${thresh.rsiLow}`);
      }
    }
  }

  // momentum adaptation
  const momTrades = tradeMemory.filter(t => t.snapshot?.chgPct != null);
  if (momTrades.length >= 5) {
    const low = momTrades.filter(t => Math.abs(t.snapshot.chgPct) < 0.5);
    if (low.length >= 3 && low.filter(t => !t.win).length / low.length > 0.6) {
      thresh.momentum = Math.min(THRESHOLD_BOUNDS.momentum.max, +(thresh.momentum + 0.2).toFixed(1));
      changed++; findings.push(`Momentum threshold → ${thresh.momentum}%`);
    }
  }

  if (changed > 0) {
    store.set('learnedThresholds', thresh);
    store.update('adaptationCount', n => (n || 0) + changed);
    log(`Learning: ${changed} threshold(s) updated after ${tradeMemory.length} trades — ${findings.join(', ')}`, 'order');
    broadcast('learning', { learnedThresholds: thresh, adaptationCount: store.get().adaptationCount, tradeMemory });
  }
}

// ── Metrics builder ───────────────────────────────────────────────────────────
function buildMetrics() {
  const { openPositions, closedPositions } = store.get();
  const totalSpent = [...openPositions, ...closedPositions].reduce((s, p) => s + (p.costBasis || 0), 0);
  const openPnl    = openPositions.filter(p => p.orderStatus === 'filled').reduce((s, p) => s + (p.currValue - p.costBasis), 0);
  const realized   = closedPositions.reduce((s, p) => s + (p.pnl || 0), 0);
  const wins       = closedPositions.filter(p => p.win).length;
  const wr         = closedPositions.length ? Math.round(wins / closedPositions.length * 100) : null;
  return { totalSpent, openPnl, realized, wins, total: closedPositions.length, wr, openCount: openPositions.length };
}

// ── Bot start/stop ────────────────────────────────────────────────────────────
let scanInterval = null;
let fillInterval = null;
let priceInterval = null;
let accountInterval = null;

function start() {
  if (store.get().autoEnabled) return;
  store.set('autoEnabled', true);
  const interval = (store.getSetting('scanInterval') || 60) * 1000;
  scanInterval    = setInterval(runScan,       interval);
  fillInterval    = setInterval(checkFillsAndRisk, 30000);
  priceInterval   = setInterval(async () => { await fetchPrices(); generateSignals(); }, 10000);
  accountInterval = setInterval(syncAccount,   60000);
  log(`Bot started — scanning ${store.get().watchlist.length} tickers every ${store.getSetting('scanInterval') || 60}s`, 'order');
  broadcast('status', { autoEnabled: true, marketOpen: isMarketOpen() });
  // run immediately
  fetchPrices().then(() => generateSignals());
  syncAccount();
}

function stop() {
  store.set('autoEnabled', false);
  [scanInterval, fillInterval, priceInterval, accountInterval].forEach(t => { if (t) clearInterval(t); });
  scanInterval = fillInterval = priceInterval = accountInterval = null;
  log('Bot stopped', 'scan');
  broadcast('status', { autoEnabled: false, marketOpen: isMarketOpen() });
}

function getStatus() {
  const s = store.get().settings;
  return {
    autoEnabled:    store.get().autoEnabled,
    marketOpen:     isMarketOpen(),
    inWindow:       isInTradingWindow(),
    etTime:         etTimeStr(),
    signals,
    cooldowns:      Object.keys(cooldownMap).filter(s => isOnCooldown(s)),
    autoCount:      store.get().autoCount,
    riskLimits: {
      maxRiskPerTrade: s.maxRiskPerTrade || 10,
      maxDailyLoss:    s.maxDailyLoss    || 5,
      maxExposure:     s.maxExposure     || 30,
    },
    account: liveAccountCache,
  };
}

// resume auto if it was running before restart
function init() {
  store.load();
  fetchPrices().then(() => generateSignals());
  syncAccount();
  if (store.get().autoEnabled) {
    log('Resuming bot after restart...', 'order');
    store.set('autoEnabled', false); // reset so start() works
    start();
  }
}

module.exports = {
  init, start, stop, getStatus, emitter, buildMetrics,
  enterTrade, exitTrade, syncAccount, runScan, runLearningCycle,
  signals, priceCache, cooldownMap, liveAccountCache,
};
