// main.js - Telegram Crypto Value Bot (AZ-style)
// - Binance P2P SELL median (USDT/VND)
// - CoinGecko prices
// - Smart calculator (rounded)
// - k/m/b + 1m2, 1b2
// - SOL / USDT / BNB output

const { Telegraf } = require("telegraf");
const axios = require("axios");

// ================== BOT TOKEN ==================
const BOT_TOKEN = "";
if (!BOT_TOKEN) {
  console.error("❌ Chưa set BOT_TOKEN");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ================== COIN CONFIG ==================
const COIN_MAP = {
  sol: "solana",
  usdt: "tether",
  usd: "tether",
  bnb: "binancecoin",
  btc: "bitcoin",
  eth: "ethereum",
  ton: "toncoin",
  avax: "avalanche-2",
  doge: "dogecoin",
};

const COIN_IDS = [...new Set(Object.values(COIN_MAP))].join(",");

// ================== COINGECKO ==================
const API_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${COIN_IDS}&vs_currencies=usd`;

let lastPrices = null;
let lastFetchTs = 0;
const PRICE_TTL_MS = 15000;

// ================== BINANCE P2P (AZ STYLE) ==================
const BINANCE_P2P_URL =
  "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";

let lastSellRate = null;
let lastSellTs = 0;
const SELL_TTL_MS = 30000;

async function getUsdtVndSellMedian(force = false) {
  const now = Date.now();
  if (!force && lastSellRate && now - lastSellTs < SELL_TTL_MS) {
    return lastSellRate;
  }

  const res = await axios.post(
    BINANCE_P2P_URL,
    {
      page: 1,
      rows: 10,
      payTypes: [],
      asset: "USDT",
      tradeType: "SELL",
      fiat: "VND",
    },
    { timeout: 5000 }
  );

  const ads = res.data?.data || [];
  if (!ads.length) throw new Error("No P2P SELL ads");

  const prices = ads
    .map((a) => Number(a.adv.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;

  lastSellRate = median;
  lastSellTs = now;
  return median;
}

// ================== PRICE FETCH ==================
async function getPrices(force = false) {
  const now = Date.now();
  if (!force && lastPrices && now - lastFetchTs < PRICE_TTL_MS) {
    return lastPrices;
  }

  const [cgRes, sellRate] = await Promise.all([
    axios.get(API_URL, { timeout: 5000 }),
    getUsdtVndSellMedian(),
  ]);

  lastPrices = {
    raw: cgRes.data,
    fxVndPerUsd: sellRate,
  };

  lastFetchTs = now;
  return lastPrices;
}

// ================== UTILS ==================
function parseAmount(str) {
  let s = str.toLowerCase().trim();

  const compact = s.match(/^(\d+)([kmb])(\d)$/);
  if (compact) {
    const base = +compact[1];
    const extra = +compact[3] / 10;
    const mult = compact[2] === "k" ? 1e3 : compact[2] === "m" ? 1e6 : 1e9;
    return (base + extra) * mult;
  }

  let num = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return NaN;

  if (s.includes("k")) num *= 1e3;
  if (s.includes("m")) num *= 1e6;
  if (s.includes("b") || s.includes("ty") || s.includes("tỷ")) num *= 1e9;
  return num;
}

function evaluateExpression(expr) {
  let s = expr.toLowerCase().replace(/,/g, "").trim();
  if (!s) return NaN;

  s = s.replace(/(\d+(?:\.\d+)?(?:[kmb]\d?)?)/gi, (m) => {
    const v = parseAmount(m);
    return isNaN(v) ? "NaN" : String(v);
  });

  if (!/^[0-9+\-*/().\s]+$/.test(s)) return NaN;

  try {
    const r = Function(`"use strict";return (${s})`)();
    return typeof r === "number" && isFinite(r) ? r : NaN;
  } catch {
    return NaN;
  }
}

function roundSmart(num, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

function getUsdValueFromCoin(amount, symbol, prices) {
  if (symbol === "usd" || symbol === "usdt") return amount;
  const id = COIN_MAP[symbol];
  return amount * prices.raw[id].usd;
}

// ================== CORE ==================
async function handleVal(ctx, input) {
  let text = input.trim().toLowerCase();
  if (text.startsWith("val ")) text = text.slice(4);

  const parts = text.split(/\s+/);
  const coin = parts.pop();
  const amountExpr = parts.join(" ");

  if (!amountExpr || !coin) return;

  const prices = await getPrices();
  let usdValue, vndValue;

  if (coin === "vnd") {
    const vnd = evaluateExpression(amountExpr);
    usdValue = vnd / prices.fxVndPerUsd;
    vndValue = vnd;
  } else {
    const amt = evaluateExpression(amountExpr);
    usdValue = getUsdValueFromCoin(amt, coin, prices);
    vndValue = usdValue * prices.fxVndPerUsd;
  }

  const sol = usdValue / prices.raw.solana.usd;
  const bnb = usdValue / prices.raw.binancecoin.usd;

  ctx.reply(
    `*${amountExpr} ${coin.toUpperCase()} =*\n\n` +
      `🇻🇳 VND (AZ): *${Math.round(vndValue).toLocaleString("vi-VN")}₫*\n` +
      `💲 USD: *${roundSmart(usdValue, 2)}$*\n\n` +
      `🪙 SOL: *${roundSmart(sol, 4)}*\n` +
      `💵 USDT: *${roundSmart(usdValue, 2)}*\n` +
      `🟡 BNB: *${roundSmart(bnb, 5)}*\n\n` +
      `📊 Rate: *1 USDT ≈ ${Math.round(prices.fxVndPerUsd).toLocaleString(
        "vi-VN"
      )}₫*`,
    { parse_mode: "Markdown" }
  );
}

// ================== TELEGRAM ==================
bot.start((ctx) =>
  ctx.reply(
    "✅ Bot online\n" +
      "`1 sol`\n`100k usdt`\n`2m vnd`\n`11.8-11.36`",
    { parse_mode: "Markdown" }
  )
);

bot.command("val", (ctx) => handleVal(ctx, ctx.message.text));

bot.on("text", async (ctx) => {
  const msg = ctx.message.text.trim();
  const lower = msg.toLowerCase();

  if (msg.startsWith("/")) return;

  // calculator
  if (/^[0-9kmb+\-*/().\s]+$/i.test(lower) && /[+\-*/]/.test(lower)) {
    const r = evaluateExpression(msg);
    if (!isNaN(r)) {
      return ctx.reply(`🖥 ${msg} = ✅ *${roundSmart(r, 2)}*`, {
        parse_mode: "Markdown",
      });
    }
  }

  // value
  if (
    /^([\d.kmb+\-*/()]+)\s+(sol|usdt|usd|vnd|bnb|btc|eth|ton|avax|doge)/i.test(
      lower
    )
  ) {
    await handleVal(ctx, msg);
  }
});

bot.launch();
console.log("🚀 Bot running (AZ-style)");
