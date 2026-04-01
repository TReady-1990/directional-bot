# Directional Options Bot — Railway Deployment Guide

## What this is
A fully autonomous directional options trading bot that:
- Runs 24/7 on Railway (no computer needed)
- Scans tickers for call/put signals using 4 conditions
- Places real limit orders in your Tradier paper account
- Manages risk with trailing stops, partial closes, and stop losses
- Learns from trade history and adapts thresholds automatically
- Serves a mobile-friendly dashboard you can view from any device

---

## Step 1 — Push to GitHub

1. Create a new **private** repository on GitHub (github.com → New repository)
2. Name it `directional-options-bot` (private is important — your code will be here)
3. Open Command Prompt on your PC and run:

```cmd
cd C:\Users\sylve\Downloads\directional-bot
git init
git add .
git commit -m "Initial deploy"
git remote add origin https://github.com/YOUR_USERNAME/directional-options-bot.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

---

## Step 2 — Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select `directional-options-bot`
4. Railway will detect the Node.js app and start building automatically

---

## Step 3 — Set Environment Variables

In your Railway project dashboard:
1. Click your service → **Variables** tab
2. Add these three variables:

| Variable | Value |
|---|---|
| `TRADIER_PROD_TOKEN` | Your production token (for market data) |
| `TRADIER_PAPER_TOKEN` | Your sandbox token (for paper orders) |
| `TRADIER_ACCOUNT_ID` | Your paper account ID (e.g. VA12345678) |

Railway will automatically restart the service after you add them.

---

## Step 4 — Get your URL

1. In your Railway project, click **Settings** → **Domains**
2. Click **Generate Domain** — you'll get a URL like `yourapp.up.railway.app`
3. **Bookmark this on your phone** — this is your dashboard

---

## Step 5 — Add to your phone's home screen

**iPhone:**
1. Open the URL in Safari
2. Tap the Share button (box with arrow)
3. Tap "Add to Home Screen"
4. Name it "Options Bot"

**Android:**
1. Open the URL in Chrome
2. Tap the menu (three dots)
3. Tap "Add to Home screen"

---

## Step 6 — Migrate your trade history

After the bot is live, open the Railway dashboard URL in your browser and run this in the browser console (F12) to import your existing trade history from localStorage:

```js
// Run this on your localhost version first to get the data
const data = {
  tradeMemory:      JSON.parse(localStorage.getItem('dirbot_trade_memory') || '[]'),
  learnedThresholds:JSON.parse(localStorage.getItem('dirbot_thresholds') || '{}'),
  adaptationCount:  parseInt(localStorage.getItem('dirbot_adaptations') || '0'),
  closedPositions:  JSON.parse(localStorage.getItem('dirbot_closed') || '[]'),
  pnlHistory:       JSON.parse(localStorage.getItem('dirbot_pnl_history') || '[]'),
  watchlist:        JSON.parse(localStorage.getItem('dirbot_watchlist') || '[]'),
};
console.log(JSON.stringify(data));
```

Then POST it to your Railway server:
```js
// Run this on the Railway dashboard URL
await fetch('/api/migrate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{ PASTE_JSON_HERE }'
});
```

---

## Updating the bot

When you want to push changes:
```cmd
git add .
git commit -m "Update settings"
git push
```

Railway deploys automatically on every push. Takes about 30 seconds.

---

## Monitoring

- **Dashboard**: `yourapp.up.railway.app` — live from any device
- **Railway logs**: Click your service → **Logs** tab for raw server output
- **Health check**: `yourapp.up.railway.app/health` — shows uptime

---

## Free tier limits

Railway's free tier gives $5/month of compute credits. A Node.js app this size uses roughly $0.50–$1.00/month, well within the free tier. If you hit the limit, upgrading to the $5/month Hobby plan gives you plenty of headroom.
