// store.js — persistent JSON storage
// Saves to ./data/state.json on the Railway server
// On Railway free tier the filesystem persists between restarts but resets on redeploy.
// To make it truly bulletproof, add Railway's free Postgres plugin later.

const fs   = require('fs');
const path = require('path');

// Use Railway persistent volume if available (/data), otherwise local ./data
const DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? process.env.RAILWAY_VOLUME_MOUNT_PATH
  : path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = {
  openPositions:    [],
  closedPositions:  [],
  pnlHistory:       [],
  tradeMemory:      [],
  learnedThresholds: {
    momentum:  0.5,
    rsiLow:    35,
    rsiHigh:   65,
    ivMax:     35,
    volMult:   1.5,
    minCond:   3,
  },
  adaptationCount:  0,
  watchlist:        ['SPY', 'QQQ'],
  settings: {
    maxPositions: 3,
    profitTarget: 50,
    stopLoss:     50,
    trailPct:     20,
    trailDollar:  0.50,
    cooldown:     15,
    timeFilt:     30,
    dte:          3,
    delta:        0.65,
    volMult:      1.5,
    rsiLow:       35,
    rsiHigh:      65,
    ivMax:        35,
    minCond:      3,
    momentum:     0.5,
    scanInterval:    60,
    fillTimeout:     3,
    maxRiskPerTrade: 10,   // max % of account per single trade
    maxDailyLoss:    5,    // % drop in account that halts trading for the day
    maxExposure:     30,   // max % of account in open positions simultaneously
  },
  autoEnabled: false,
  autoCount:   0,
};

let state = { ...DEFAULT_STATE };

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw  = fs.readFileSync(STATE_FILE, 'utf8');
      const saved = JSON.parse(raw);
      // deep merge — saved values override defaults, new defaults fill gaps
      state = {
        ...DEFAULT_STATE,
        ...saved,
        settings:          { ...DEFAULT_STATE.settings,          ...(saved.settings          || {}) },
        learnedThresholds: { ...DEFAULT_STATE.learnedThresholds, ...(saved.learnedThresholds || {}) },
      };
      console.log(`[store] Loaded state: ${state.closedPositions.length} closed trades, ${state.openPositions.length} open positions`);
    } else {
      console.log('[store] No state file found — starting fresh');
      save();
    }
  } catch(e) {
    console.error('[store] Load error:', e.message, '— starting fresh');
  }
  return state;
}

function save() {
  ensureDataDir();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch(e) {
    console.error('[store] Save error:', e.message);
  }
}

function get()               { return state; }
function set(key, value)     { state[key] = value; save(); }
function update(key, fn)     { state[key] = fn(state[key]); save(); }
function getSetting(key)     { return state.settings[key]; }
function setSetting(key, val){ state.settings[key] = val; save(); }
function setSettings(obj)    { state.settings = { ...state.settings, ...obj }; save(); }

module.exports = { load, save, get, set, update, getSetting, setSetting, setSettings };
