// main.js - Telegram Crypto Value Bot (AZ-style + FIXED + TON Binance fallback)
// - Binance P2P SELL median (USDT/VND) => AZ-like rate
// - CoinGecko prices (USD)
// - TON hard fallback from Binance TONUSDT if CoinGecko misses TON
// - Smart calculator output: 🖥 expr = ✅ result
// - k/m/b + 1m2, 1b2, 10k5
// - value output: VND, USD, SOL, USDT, BNB

const { Telegraf } = require("telegraf");
const axios = require("axios");

// ================== BOT TOKEN ==================
const BOT_TOKEN = process.env.BOT_TOKEN || "";

if (!BOT_TOKEN) {
  console.error("❌ Chưa set BOT_TOKEN (env BOT_TOKEN hoặc sửa trong file)!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ================== COIN CONFIG ==================
const COIN_MAP = {
  sol: ["solana"],
  usdt: ["tether"],
  usd: ["tether"],
  bnb: ["binancecoin"],
  btc: ["bitcoin"],
  eth: ["ethereum"],
  ton: ["toncoin", "the-open-network"],
  avax: ["avalanche-2"],
  doge: ["dogecoin"],
};

const COIN_IDS = [...new Set(Object.values(COIN_MAP).flat())].join(",");

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
    {
      headers: { "content-type": "application/json" },
      timeout: 5000,
    }
  );

  const ads = res.data?.data || [];
  if (!ads.length) throw new Error("No P2P SELL ads");

  const prices = ads
    .map((a) => Number(a.adv?.price))
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);

  if (!prices.length) throw new Error("No valid P2P prices");

  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;

  lastSellRate = median;
  lastSellTs = now;

  return median;
}

// ================== BINANCE SPOT FALLBACK ==================
async function getBinanceSpotPrice(symbol) {
  const res = await axios.get(
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
    { timeout: 5000 }
  );

  const price = Number(res.data?.price);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid Binance price for ${symbol}`);
  }

  return price;
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

  const raw = cgRes.data || {};

  // ✅ HARD FIX TON:
  // Nếu CoinGecko không trả TON thì lấy từ Binance TONUSDT.
  const tonFromCg =
    raw.toncoin?.usd ||
    raw["the-open-network"]?.usd;

  if (!tonFromCg) {
    try {
      const tonUsd = await getBinanceSpotPrice("TONUSDT");

      raw.toncoin = { usd: tonUsd };
      raw["the-open-network"] = { usd: tonUsd };

      console.log(`✅ TON fallback from Binance: ${tonUsd}`);
    } catch (err) {
      console.error("⚠ Binance TON fallback failed:", err?.message || err);
    }
  }

  lastPrices = {
    raw,
    fxVndPerUsd: sellRate,
  };

  lastFetchTs = now;

  return lastPrices;
}

// ================== UTILS ==================
function parseAmount(str) {
  let s = String(str).toLowerCase().trim();

  // pattern: 1b2, 1m2, 10k5
  const compact = s.match(/^(\d+)([kmb])(\d)$/);

  if (compact) {
    const base = parseInt(compact[1], 10);
    const suffix = compact[2];
    const extra = parseInt(compact[3], 10);

    let mult = 1;

    if (suffix === "k") mult = 1_000;
    if (suffix === "m") mult = 1_000_000;
    if (suffix === "b") mult = 1_000_000_000;

    return (base + extra / 10) * mult;
  }

  // normal: 100k, 5m, 2b, 1.5m ...
  let num = parseFloat(s.replace(/[^0-9.]/g, ""));

  if (isNaN(num)) return NaN;

  if (s.includes("k")) num *= 1_000;
  if (s.includes("m")) num *= 1_000_000;
  if (s.includes("b") || s.includes("ty") || s.includes("tỷ")) {
    num *= 1_000_000_000;
  }

  return num;
}

function evaluateExpression(expr) {
  let s = String(expr).toLowerCase().replace(/,/g, "").trim();

  if (!s) return NaN;

  // replace number tokens with expanded numeric
  s = s.replace(/(\d+(?:\.\d+)?(?:[kmb]\d?)?)/gi, (match) => {
    const val = parseAmount(match);
    return isNaN(val) ? "NaN" : String(val);
  });

  // allow only safe chars
  if (!/^[0-9+\-*/().\s]+$/.test(s)) return NaN;

  try {
    const result = Function(`"use strict"; return (${s});`)();

    if (typeof result !== "number" || !isFinite(result)) {
      return NaN;
    }

    return result;
  } catch {
    return NaN;
  }
}

// rounding to kill 0.4400000000000013
function roundSmart(num, decimals = 2) {
  if (!isFinite(num)) return NaN;

  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function formatNumberSmart(num) {
  // show integer nicely, else keep up to 2 decimals
  const r = roundSmart(num, 2);

  if (Number.isNaN(r)) return "NaN";

  if (Math.abs(r - Math.round(r)) < 1e-12) {
    return Math.round(r).toLocaleString("vi-VN");
  }

  return String(r).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function getUsdPrice(symbol, prices) {
  const sym = symbol.toLowerCase();

  if (sym === "usd" || sym === "usdt") {
    return 1;
  }

  const ids = COIN_MAP[sym];

  if (!ids) {
    throw new Error(`Unsupported coin: ${symbol}`);
  }

  for (const id of ids) {
    const p = prices.raw[id]?.usd;

    if (p && Number.isFinite(p)) {
      return p;
    }
  }

  throw new Error(`Missing USD price for ${symbol}`);
}

function getUsdValueFromCoin(amount, symbol, prices) {
  return amount * getUsdPrice(symbol, prices);
}

// ================== CORE ==================
async function handleVal(ctx, rawInput) {
  let text = String(rawInput || "").trim().toLowerCase();

  // strip both "val " and "/val "
  if (text.startsWith("/val")) {
    text = text.replace(/^\/val\s*/i, "").trim();
  }

  if (text.startsWith("val ")) {
    text = text.slice(4).trim();
  }

  if (!text) {
    return ctx.reply(
      "📌 Format:\n" +
        "- `/val 1 sol`\n" +
        "- `val 1 sol`\n" +
        "- `1 sol`\n" +
        "- `1 ton`\n" +
        "- `100k usdt`\n" +
        "- `2m vnd`\n\n" +
        "Calculator:\n" +
        "- `11.8-11.36`\n" +
        "- `100k+20k`",
      { parse_mode: "Markdown" }
    );
  }

  const parts = text.split(/\s+/);
  const coin = parts.pop();
  const amountExpr = parts.join(" ");

  if (!amountExpr || !coin) {
    return ctx.reply(
      "❌ Sai format. Ví dụ: `/val 1 sol`, `1 ton`, `100k usdt`, `11.8-11.36`",
      { parse_mode: "Markdown" }
    );
  }

  const prices = await getPrices();

  let usdValue;
  let vndValue;
  const headerText = `${amountExpr} ${coin}`.trim();

  if (coin === "vnd") {
    const vnd = evaluateExpression(amountExpr);

    if (!Number.isFinite(vnd)) {
      return ctx.reply(
        "❌ Amount VND không hợp lệ (vd: `100k vnd`, `2m vnd`, `1b2 vnd`).",
        { parse_mode: "Markdown" }
      );
    }

    usdValue = vnd / prices.fxVndPerUsd;
    vndValue = vnd;
  } else {
    const amount = evaluateExpression(amountExpr);

    if (!Number.isFinite(amount)) {
      return ctx.reply("❌ Amount không hợp lệ.");
    }

    if (!COIN_MAP[coin]) {
      return ctx.reply(
        "⚠ Coin chưa hỗ trợ.\n" +
          "Hỗ trợ: `sol`, `usdt`, `usd`, `bnb`, `btc`, `eth`, `ton`, `avax`, `doge`, `vnd`",
        { parse_mode: "Markdown" }
      );
    }

    usdValue = getUsdValueFromCoin(amount, coin, prices);
    vndValue = usdValue * prices.fxVndPerUsd;
  }

  const solPrice = getUsdPrice("sol", prices);
  const bnbPrice = getUsdPrice("bnb", prices);

  if (!solPrice || !bnbPrice) {
    throw new Error("Missing SOL/BNB price");
  }

  const solAmount = usdValue / solPrice;
  const bnbAmount = usdValue / bnbPrice;

  return ctx.reply(
    `*${headerText.toUpperCase()} =*\n\n` +
      `🇻🇳 VND (AZ): *${Math.round(vndValue).toLocaleString("vi-VN")}₫*\n` +
      `💲 USD: *${formatNumberSmart(usdValue)}$*\n\n` +
      `🪙 SOL: *${formatNumberSmart(solAmount)}*\n` +
      `💵 USDT: *${formatNumberSmart(usdValue)}*\n` +
      `🟡 BNB: *${formatNumberSmart(bnbAmount)}*\n\n` +
      `📊 Rate: *1 USDT ≈ ${Math.round(prices.fxVndPerUsd).toLocaleString("vi-VN")}₫*`,
    { parse_mode: "Markdown" }
  );
}

// ================== TELEGRAM ==================
bot.start((ctx) => {
  ctx.reply(
    "✅ Bot online!\n\n" +
      "Value:\n" +
      "- `/val 1 sol`\n" +
      "- `val 1 sol`\n" +
      "- `1 sol`\n" +
      "- `1 ton`\n" +
      "- `100k usdt`\n" +
      "- `2m vnd`\n\n" +
      "Calculator:\n" +
      "- `11.8-11.36`\n" +
      "- `100k+20k`",
    { parse_mode: "Markdown" }
  );
});

// /val command
bot.command("val", async (ctx) => {
  const raw = ctx.message.text.replace(/^\/val\s*/i, "");

  try {
    await handleVal(ctx, raw);
  } catch (err) {
    console.error("❌ Error in /val:", err?.message || err);

    if (err?.response?.status === 429) {
      return ctx.reply("⚠ API đang bị rate limit (429). Đợi vài giây rồi thử lại nha.");
    }

    ctx.reply("❌ Có lỗi xảy ra, thử lại sau.");
  }
});

bot.on("text", async (ctx) => {
  const msg = ctx.message.text.trim();
  const lower = msg.toLowerCase();

  if (msg.startsWith("/")) return;

  // 1) PURE CALCULATOR MODE
  const calcPattern = /^[0-9kmb+\-*/().\s]+$/i;

  if (calcPattern.test(lower) && /[+\-*/]/.test(lower)) {
    const rawResult = evaluateExpression(msg);

    if (!isNaN(rawResult)) {
      const out = formatNumberSmart(rawResult);

      // FIX: no Markdown here, so "12*25" will not break Telegram parser
      return ctx.reply(`🖥 ${msg} = ✅ ${out}`);
    }
  }

  // 2) VALUE MODE
  const valuePattern =
    /^([\d.kmb+\-*/()]+)\s+(sol|usdt|usd|vnd|bnb|btc|eth|ton|avax|doge)\b/i;

  if (valuePattern.test(lower) || lower.startsWith("val ")) {
    try {
      await handleVal(ctx, msg);
    } catch (err) {
      console.error("❌ Error in text:", err?.message || err);

      if (err?.response?.status === 429) {
        return ctx.reply("⚠ API đang bị rate limit (429). Đợi vài giây rồi thử lại nha.");
      }

      ctx.reply("❌ Có lỗi xảy ra, thử lại sau.");
    }
  }
});

bot.catch((err, ctx) => {
  console.error(`❌ Lỗi ngoài handler (${ctx.updateType}):`, err);
});

bot.launch();
console.log("🚀 Telegram Crypto Value Bot running (AZ-style + TON Binance fallback)...");
