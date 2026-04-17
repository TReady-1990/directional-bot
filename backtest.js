// backtest.js — Black-Scholes backtesting + parameter optimization engine
// Uses Tradier historical daily OHLC to simulate signal conditions
// Uses Black-Scholes to estimate option prices at entry and exit

'use strict';
const fetch = require('node-fetch');

const PROD_BASE = 'https://api.tradier.com/v1';
function prodHeaders() {
  return { Authorization: `Bearer ${process.env.TRADIER_PROD_TOKEN}`, Accept: 'application/json' };
}

// ── Black-Scholes option pricer ───────────────────────────────────────────────
function blackScholes(S, K, T, r, sigma, type) {
  if (T <= 0) return Math.max(0, type === 'call' ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const nd1 = normalCDF(type === 'call' ? d1 : -d1);
  const nd2 = normalCDF(type === 'call' ? d2 : -d2);
  if (type === 'call') return S * nd1 - K * Math.exp(-r * T) * nd2;
  return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
}

function normalCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return 0.5 * (1 + sign * y);
}

// estimate IV from historical volatility (20-day rolling)
function estimateIV(closes) {
  if (closes.length < 5) return 0.30;
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean    = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  return Math.min(2.0, Math.max(0.10, Math.sqrt(variance * 252))); // annualized
}

// estimate IV rank (0-99) from historical IV
function estimateIVRank(currentIV, historicalIVs) {
  if (!historicalIVs.length) return 30;
  const below = historicalIVs.filter(v => v <= currentIV).length;
  return Math.round((below / historicalIVs.length) * 99);
}

// ── Historical data fetcher ───────────────────────────────────────────────────
async function fetchHistory(sym, startDate, endDate) {
  try {
    const res  = await fetch(
      `${PROD_BASE}/markets/history?symbol=${sym}&interval=daily&start=${startDate}&end=${endDate}`,
      { headers: prodHeaders() }
    );
    const data = await res.json();
    const days = data?.history?.day;
    if (!days) return [];
    const arr = Array.isArray(days) ? days : [days];
    return arr.map(d => ({
      date:   d.date,
      open:   parseFloat(d.open),
      high:   parseFloat(d.high),
      low:    parseFloat(d.low),
      close:  parseFloat(d.close),
      volume: parseInt(d.volume || 0),
    }));
  } catch(e) {
    return [];
  }
}

// ── RSI calculation (14-period Wilder's) ──────────────────────────────────────
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = changes.slice(0, period).filter(c => c > 0).reduce((s, v) => s + v, 0) / period;
  let avgLoss = changes.slice(0, period).filter(c => c < 0).reduce((s, v) => s + Math.abs(v), 0) / period;
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return Math.round(100 - (100 / (1 + rs)));
}

// ── Single ticker backtest ────────────────────────────────────────────────────
function backtestTicker(sym, history, params) {
  const {
    rsiLow, rsiHigh, momentum, minCond, ivMax, volMult,
    profitTarget, stopLoss, dte, delta,
  } = params;

  const trades = [];
  const RSI_PERIOD = 14;
  const IV_PERIOD  = 20;
  const RISK_FREE  = 0.05;
  const avgVol = history.slice(-30).reduce((s, d) => s + d.volume, 0) / 30 || 1;

  for (let i = RSI_PERIOD + IV_PERIOD; i < history.length - dte - 1; i++) {
    const day      = history[i];
    const prevDay  = history[i - 1];
    const closes   = history.slice(i - RSI_PERIOD - 1, i + 1).map(d => d.close);
    const ivCloses = history.slice(i - IV_PERIOD, i + 1).map(d => d.close);

    const rsi       = calculateRSI(closes);
    const chgPct    = ((day.close - prevDay.close) / prevDay.close) * 100;
    const currentIV = estimateIV(ivCloses);
    const histIVs   = [];
    for (let j = IV_PERIOD; j < i; j++) {
      const slice = history.slice(j - IV_PERIOD, j + 1).map(d => d.close);
      histIVs.push(estimateIV(slice));
    }
    const ivRank   = estimateIVRank(currentIV, histIVs);
    const volSpike = day.volume / avgVol;

    // ── Check conditions ──────────────────────────────────────────────────────
    const cMomentum = Math.abs(chgPct) >= momentum;
    const cRsi      = rsi <= rsiLow || rsi >= rsiHigh;
    const cIV       = ivRank <= ivMax;
    const cVol      = volSpike >= volMult;
    const metCount  = [cMomentum, cRsi, cIV, cVol].filter(Boolean).length;

    if (metCount < minCond) continue;

    // ── Determine direction ───────────────────────────────────────────────────
    const bullish = chgPct > 0 && rsi <= rsiLow;
    const bearish = chgPct < 0 && rsi >= rsiHigh;
    let direction;
    if (bullish && !bearish)      direction = 'call';
    else if (bearish && !bullish) direction = 'put';
    else                          direction = chgPct > 0 ? 'call' : 'put';

    // ── Black-Scholes entry price ─────────────────────────────────────────────
    const S     = day.close;
    const T_in  = dte / 252;
    // strike at delta target — approximate using S * e^(±sigma*sqrt(T)*z)
    const z     = direction === 'call' ? 0.35 : -0.35; // ~0.65 delta ITM
    const K     = Math.round(S * Math.exp(-z * currentIV * Math.sqrt(T_in)) / 0.5) * 0.5;
    const entryPrice = blackScholes(S, K, T_in, RISK_FREE, currentIV, direction);
    if (entryPrice <= 0.05) continue;

    // ── Simulate hold period — check profit target and stop loss each day ─────
    let exitPrice    = entryPrice;
    let exitDay      = null;
    let closeReason  = 'expired';
    let win          = false;

    for (let j = i + 1; j <= Math.min(i + dte, history.length - 1); j++) {
      const futureDay = history[j];
      const T_rem     = (i + dte - j) / 252;
      const futureIV  = estimateIV(history.slice(j - IV_PERIOD, j + 1).map(d => d.close));
      const simPrice  = blackScholes(futureDay.close, K, Math.max(T_rem, 0.001), RISK_FREE, futureIV, direction);
      const pnlPct    = (simPrice - entryPrice) / entryPrice;

      if (pnlPct >= profitTarget / 100) {
        exitPrice   = simPrice;
        exitDay     = futureDay.date;
        closeReason = 'profit target';
        win         = true;
        break;
      }
      if (pnlPct <= -stopLoss / 100) {
        exitPrice   = simPrice;
        exitDay     = futureDay.date;
        closeReason = 'stop loss';
        win         = false;
        break;
      }
      exitPrice = simPrice;
      exitDay   = futureDay.date;
    }

    if (exitPrice <= 0) continue;

    const pnl    = +(exitPrice - entryPrice).toFixed(2);
    const pnlPct = +((pnl / entryPrice) * 100).toFixed(1);
    win = pnl > 0;

    trades.push({
      sym, direction,
      entryDate:   day.date,
      exitDate:    exitDay || history[Math.min(i + dte, history.length - 1)].date,
      entryPrice:  +entryPrice.toFixed(2),
      exitPrice:   +exitPrice.toFixed(2),
      strike:      K,
      stockPrice:  S,
      rsi, ivRank, chgPct: +chgPct.toFixed(2), volSpike: +volSpike.toFixed(1),
      metCount, pnl, pnlPct, win, closeReason,
    });
  }
  return trades;
}

// ── Full backtest across all tickers ─────────────────────────────────────────
async function runBacktest(tickers, params, startDate, endDate, onProgress) {
  const allTrades = [];
  let done = 0;

  for (const sym of tickers) {
    const history = await fetchHistory(sym, startDate, endDate);
    if (history.length < 30) { done++; continue; }
    const trades = backtestTicker(sym, history, params);
    allTrades.push(...trades);
    done++;
    if (onProgress) onProgress(done, tickers.length, sym);
    await new Promise(r => setTimeout(r, 100)); // rate limit courtesy delay
  }

  return buildResults(allTrades, params);
}

// ── Results builder ───────────────────────────────────────────────────────────
function buildResults(trades, params) {
  if (!trades.length) return { trades: [], metrics: { totalTrades: 0 }, params };

  trades.sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));

  const wins       = trades.filter(t => t.win).length;
  const winRate    = +(wins / trades.length * 100).toFixed(1);
  const totalPnl   = +trades.reduce((s, t) => s + t.pnl, 0).toFixed(2);
  const avgWin     = +trades.filter(t => t.win).reduce((s, t) => s + t.pnlPct, 0) / (wins || 1);
  const avgLoss    = +trades.filter(t => !t.win).reduce((s, t) => s + t.pnlPct, 0) / ((trades.length - wins) || 1);

  // P&L curve
  let cum = 0;
  const pnlCurve = trades.map(t => {
    cum += t.pnl * 100; // ×100 for contract value
    return { date: t.exitDate, value: +cum.toFixed(0), win: t.win };
  });

  // max drawdown
  let peak = 0, maxDD = 0, runningPnl = 0;
  trades.forEach(t => {
    runningPnl += t.pnl * 100;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDD) maxDD = dd;
  });

  // Sharpe ratio (simplified — daily returns)
  const returns  = trades.map(t => t.pnlPct / 100);
  const meanRet  = returns.reduce((s, v) => s + v, 0) / returns.length;
  const stdRet   = Math.sqrt(returns.reduce((s, v) => s + (v - meanRet) ** 2, 0) / returns.length);
  const sharpe   = stdRet > 0 ? +((meanRet / stdRet) * Math.sqrt(252)).toFixed(2) : 0;

  // monthly breakdown
  const monthly = {};
  trades.forEach(t => {
    const month = t.exitDate.slice(0, 7);
    if (!monthly[month]) monthly[month] = { pnl: 0, trades: 0, wins: 0 };
    monthly[month].pnl    += t.pnl * 100;
    monthly[month].trades += 1;
    monthly[month].wins   += t.win ? 1 : 0;
  });

  return {
    trades,
    params,
    metrics: {
      totalTrades:  trades.length,
      wins,
      losses:       trades.length - wins,
      winRate,
      totalPnlDollar: +(totalPnl * 100).toFixed(0),
      avgWinPct:    +avgWin.toFixed(1),
      avgLossPct:   +avgLoss.toFixed(1),
      maxDrawdown:  +maxDD.toFixed(0),
      sharpeRatio:  sharpe,
      profitFactor: Math.abs(avgLoss) > 0 ? +(avgWin / Math.abs(avgLoss)).toFixed(2) : 0,
      bestTrade:    +Math.max(...trades.map(t => t.pnlPct)).toFixed(1),
      worstTrade:   +Math.min(...trades.map(t => t.pnlPct)).toFixed(1),
    },
    pnlCurve,
    monthly: Object.entries(monthly).map(([m, v]) => ({
      month: m,
      pnl:   +v.pnl.toFixed(0),
      trades: v.trades,
      winRate: +(v.wins / v.trades * 100).toFixed(1),
    })),
  };
}

// ── Parameter optimizer ───────────────────────────────────────────────────────
// Tests a grid of parameter combinations and ranks by Sharpe ratio
async function optimizeParams(tickers, startDate, endDate, onProgress) {
  const grid = {
    rsiLow:       [25, 30, 35, 40],
    rsiHigh:      [60, 65, 70, 75],
    momentum:     [0.3, 0.5, 0.8, 1.2],
    minCond:      [2, 3, 4],
    ivMax:        [25, 35, 45],
    volMult:      [1.2, 1.5, 2.0],
    profitTarget: [30, 50, 75, 100],
    stopLoss:     [30, 50, 75],
    dte:          [2, 3, 5],
    delta:        [0.65],
  };

  // build smart sample — not all combinations (would be millions)
  // use Latin Hypercube-style sampling: 80 representative combinations
  const combinations = [];
  for (let i = 0; i < 80; i++) {
    combinations.push({
      rsiLow:       grid.rsiLow[i % grid.rsiLow.length],
      rsiHigh:      grid.rsiHigh[i % grid.rsiHigh.length],
      momentum:     grid.momentum[i % grid.momentum.length],
      minCond:      grid.minCond[i % grid.minCond.length],
      ivMax:        grid.ivMax[i % grid.ivMax.length],
      volMult:      grid.volMult[i % grid.volMult.length],
      profitTarget: grid.profitTarget[i % grid.profitTarget.length],
      stopLoss:     grid.stopLoss[i % grid.stopLoss.length],
      dte:          grid.dte[i % grid.dte.length],
      delta:        0.65,
    });
  }

  // deduplicate
  const seen  = new Set();
  const unique = combinations.filter(c => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  const results = [];
  let done = 0;

  // fetch history once per ticker (shared across all param combos)
  const historyMap = {};
  for (const sym of tickers) {
    historyMap[sym] = await fetchHistory(sym, startDate, endDate);
    await new Promise(r => setTimeout(r, 100));
  }

  for (const params of unique) {
    const allTrades = [];
    for (const sym of tickers) {
      const history = historyMap[sym];
      if (!history || history.length < 30) continue;
      allTrades.push(...backtestTicker(sym, history, params));
    }
    if (allTrades.length >= 10) {
      const result = buildResults(allTrades, params);
      results.push(result);
    }
    done++;
    if (onProgress) onProgress(done, unique.length);
  }

  // rank by Sharpe ratio, break ties with win rate
  results.sort((a, b) =>
    b.metrics.sharpeRatio - a.metrics.sharpeRatio ||
    b.metrics.winRate - a.metrics.winRate
  );

  return {
    topResults:  results.slice(0, 5),  // top 5 parameter sets
    totalTested: unique.length,
    bestParams:  results[0]?.params || null,
    bestMetrics: results[0]?.metrics || null,
  };
}

module.exports = { runBacktest, optimizeParams, buildResults };
