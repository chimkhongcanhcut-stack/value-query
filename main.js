// main.js - Telegram Crypto Value Bot
// - CommonJS
// - auto-parse
// - cache CoinGecko
// - multi-coin (SOL, USDT, BTC, ETH, BNB, TON, AVAX, DOGE)
// - k/m/b + dạng 1m2, 1b2, 10k5
// - + - * / cho amount & calculator thường
// - output: VND, USD, SOL, USDT

const { Telegraf } = require("telegraf");
const axios = require("axios");

// 👉 THAY TOKEN BOT CỦA BẠN VÀO ĐÂY
const BOT_TOKEN = "";

if (!BOT_TOKEN || BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN") {
  console.error("❌ Chưa set BOT_TOKEN trong code!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ================== COIN CONFIG ==================

// map symbol -> CoinGecko id
const COIN_MAP = {
  sol: "solana",
  usdt: "tether",
  usd: "tether", // treat usd like usdt
  bnb: "binancecoin",
  btc: "bitcoin",
  eth: "ethereum",
  ton: "toncoin",
  avax: "avalanche-2",
  doge: "dogecoin",
};

// build ids string for API
const COIN_IDS = Array.from(new Set(Object.values(COIN_MAP))).join(",");

// ================== FX CONFIG (BINANCE) ==================
// 👉 Tỉ giá chuẩn: 1 USDT ~ 27.500 VND (Binance bán ra)
// Sau này Binance đổi, chỉ cần sửa con số này.
const FX_VND_PER_USD = 27058;

// ================== PRICE API + CACHE ==================

const API_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${COIN_IDS}&vs_currencies=usd`;

let lastPrices = null;
let lastFetchTs = 0;
const PRICE_TTL_MS = 15000; // cache 15s

async function getPrices(force = false) {
  const now = Date.now();

  // Nếu đã có cache và chưa quá TTL → dùng lại, khỏi gọi API
  if (!force && lastPrices && now - lastFetchTs < PRICE_TTL_MS) {
    return lastPrices;
  }

  console.log("🌐 Fetching prices from CoinGecko...");
  const res = await axios.get(API_URL, { timeout: 5000 });

  const data = res.data;

  if (!data.tether || !data.tether.usd) {
    throw new Error("Missing tether USD price data from CoinGecko");
  }

  // dùng tỉ giá cố định từ Binance
  const fxVndPerUsd = FX_VND_PER_USD;

  lastPrices = {
    raw: data, // full data by id (chỉ có usd)
    fxVndPerUsd, // VND per 1 USD (Binance)
  };

  lastFetchTs = now;
  return lastPrices;
}

// ================== UTILS ==================

// universal parser cho amount (áp dụng cho mọi coin & VND)
// Hỗ trợ:
//  - 100k  -> 100,000
//  - 2m    -> 2,000,000
//  - 1b    -> 1,000,000,000
//  - 1k2   -> 1,200
//  - 1m2   -> 1,200,000
//  - 1b2   -> 1,200,000,000
//  - 10k5  -> 10,500
function parseAmount(str) {
  let s = str.toLowerCase().trim();

  // pattern: 1b2, 1m2, 10k5
  const compactMatch = s.match(/^(\d+)([kmb])(\d)$/);
  if (compactMatch) {
    const base = parseInt(compactMatch[1], 10);
    const suffix = compactMatch[2];
    const extra = parseInt(compactMatch[3], 10);

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
  if (s.includes("b") || s.includes("ty") || s.includes("tỷ")) num *= 1_000_000_000;

  return num;
}

// evaluate expression có + - * /, k/m/b, 1m2, 1b2...
// ví dụ: "100k+20k", "1m2/2", "1b-200m"
function evaluateExpression(expr) {
  let s = expr.toLowerCase().replace(/,/g, "").trim();
  if (!s) return NaN;

  // thay mọi token số (có thể có k/m/b/1 digit) bằng số full
  s = s.replace(/(\d+(?:\.\d+)?(?:[kmb]\d?)?)/gi, (match) => {
    const val = parseAmount(match);
    if (isNaN(val)) return "NaN";
    return String(val);
  });

  // chỉ cho phép số, +-*/(). và space sau khi thay
  if (!/^[0-9+\-*/().\s]+$/.test(s)) {
    return NaN;
  }

  try {
    const result = Function(`"use strict"; return (${s});`)();
    if (typeof result !== "number" || !isFinite(result)) return NaN;
    return result;
  } catch {
    return NaN;
  }
}

// get USD value from input amount + coin
function getUsdValueFromCoin(amount, symbol, prices) {
  const sym = symbol.toLowerCase();

  if (sym === "usd" || sym === "usdt") {
    return amount; // 1 USDT ~ 1 USD
  }

  const id = COIN_MAP[sym];
  if (!id) {
    throw new Error(`Unsupported coin symbol: ${symbol}`);
  }

  const coinData = prices.raw[id];
  if (!coinData || !coinData.usd) {
    throw new Error(`Missing USD price for ${symbol}`);
  }

  return amount * coinData.usd;
}

// format SOL smart:
//  - >= 1    → 1 số sau dấu chấm (357.9012 -> 357.9)
//  - >= 0.01 → 3 số sau dấu chấm
//  - nhỏ hơn -> 6 số sau dấu chấm
function formatSolAmount(solAmount) {
  if (solAmount >= 1) {
    return solAmount.toFixed(1);
  } else if (solAmount >= 0.01) {
    return solAmount.toFixed(3);
  } else {
    return solAmount.toFixed(6);
  }
}

// format USDT:
//  - >= 1000 → floor & format theo vi-VN (45490.73 -> "45.490")
//  - < 1000  → 2 số sau dấu chấm (12.3456 -> "12.35")
function formatUsdtAmount(usdtAmount) {
  if (usdtAmount >= 1000) {
    return Math.floor(usdtAmount).toLocaleString("vi-VN");
  } else {
    return usdtAmount.toFixed(2);
  }
}

// ================== CORE HANDLER ==================

async function handleVal(ctx, rawInput) {
  const original = rawInput.trim();        // giữ nguyên để show header đẹp
  const raw = original.toLowerCase();      // dùng cho parse

  if (!raw) {
    return ctx.reply(
      "📌 Format: `val <amount> <coin>` hoặc chỉ `<amount> <coin>`\n" +
        "Hỗ trợ k/m/b, 1m2, 1b2, + - * /\n" +
        "Ví dụ:\n" +
        "- `val 1 sol`\n" +
        "- `100 usdt`\n" +
        "- `100k usdt`\n" +
        "- `100k+20k usdt`\n" +
        "- `500k vnd`\n" +
        "- `2m vnd`\n" +
        "- `1b2 vnd`\n" +
        "- `0.01 btc`\n" +
        "- `0.5 eth`",
      { parse_mode: "Markdown" }
    );
  }

  // Cho phép: "val 1 sol" hoặc "1 sol" hoặc "100k+20k usdt"
  let text = raw;
  if (text.startsWith("val ")) {
    text = text.slice(4).trim();
  }

  // tách coin là từ cuối, phần trước là expression amount
  const parts = text.split(/\s+/);
  const coin = parts.pop();
  const amountExpr = parts.join(" ");

  if (!amountExpr || !coin) {
    return ctx.reply(
      "❌ Sai format. Ví dụ: `val 1 sol`, `100k usdt`, `100k+20k usdt`, `2m vnd`, `1b2 vnd`, `0.01 btc`"
    );
  }

  const prices = await getPrices(); // dùng cache

  let usdValue;
  let vndValue;
  let headerText = `${amountExpr} ${coin}`.trim();

  // Trường hợp input là VND (expression)
  if (coin === "vnd") {
    const vnd = evaluateExpression(amountExpr);
    if (!vnd || isNaN(vnd)) {
      return ctx.reply(
        "❌ Amount VND không hợp lệ (ví dụ: `100k vnd`, `2m vnd`, `1b vnd`, `1b2 vnd`, `100k+20k vnd`)."
      );
    }
    usdValue = vnd / prices.fxVndPerUsd; // dùng tỉ giá Binance
    vndValue = vnd;
  } else {
    const amount = evaluateExpression(amountExpr);
    if (isNaN(amount)) {
      return ctx.reply("❌ Amount không hợp lệ.");
    }

    // coin khác vnd → quy ra USD
    if (!COIN_MAP[coin]) {
      return ctx.reply(
        "⚠ Coin chưa hỗ trợ.\n" +
          "Hiện hỗ trợ: `sol`, `usdt`, `usd`, `bnb`, `btc`, `eth`, `ton`, `avax`, `doge`, `vnd`"
      );
    }

    usdValue = getUsdValueFromCoin(amount, coin, prices);
    vndValue = usdValue * prices.fxVndPerUsd; // dùng tỉ giá Binance
  }

  // từ tổng USD value → suy ra SOL & USDT
  const solPrice = prices.raw["solana"]?.usd;
  if (!solPrice) {
    throw new Error("Missing SOL price");
  }

  const solAmount = usdValue / solPrice;
  const usdtAmount = usdValue; // 1 USDT ~ 1 USD

  const solDisplay = formatSolAmount(solAmount);
  const usdtDisplay = formatUsdtAmount(usdtAmount);

  // header kiểu: "1 SOL =" hoặc "100k+20k usdt ="
  const headerLine = `${headerText.toUpperCase()} =`;

  return ctx.reply(
    `${headerLine}\n\n` +
      `🇻🇳 VND: *${Math.round(vndValue).toLocaleString("vi-VN")}₫*\n` +
      `💲 USD: *${usdValue.toFixed(2)}$*\n\n` +
      `🪙 SOL: *${solDisplay}*\n` +
      `💵 USDT: *${usdtDisplay}*`,
    { parse_mode: "Markdown" }
  );
}

// ================== TELEGRAM HANDLERS ==================

// /start
bot.start((ctx) => {
  console.log("✅ /start từ:", ctx.chat.id, ctx.chat.username || ctx.chat.first_name);
  ctx.reply(
    "✅ Bot online!\n" +
      "Bạn có thể dùng:\n" +
      "- `/val 1 sol`\n" +
      "- `val 1 sol`\n" +
      "- `1 sol`\n" +
      "- `100k usdt`\n" +
      "- `100k+20k usdt`\n" +
      "- `2m vnd`\n" +
      "- `1b2 vnd`\n" +
      "- `0.01 btc`\n" +
      "- `0.5 eth`\n\n" +
      "Hoặc dùng như calculator:\n" +
      "- `100k+20k`\n" +
      "- `1m2/2`",
    { parse_mode: "Markdown" }
  );
});

// Lệnh /val (giữ lại cho tiện)
bot.command("val", async (ctx) => {
  console.log("🚀 /val:", ctx.message.text);
  const raw = ctx.message.text.replace("/val", "");
  try {
    await handleVal(ctx, raw);
  } catch (err) {
    console.error("❌ Error in /val:", err.message);

    if (err.response && err.response.status === 429) {
      return ctx.reply(
        "⚠ API giá (CoinGecko) đang bị rate limit (429).\nĐợi vài giây rồi thử lại nha."
      );
    }

    ctx.reply("❌ Có lỗi xảy ra, thử lại sau.");
  }
});

// Auto parse mọi text
bot.on("text", async (ctx) => {
  const msg = ctx.message.text.trim();
  console.log("📩 text:", msg);

  // Bỏ qua các lệnh bắt đầu bằng /
  if (msg.startsWith("/")) return;

  const lower = msg.toLowerCase();

  // 1) PURE CALCULATOR MODE (chỉ số + k/m/b + +-*/ )
  const calcPattern = /^[0-9kmb+\-*/().\s]+$/i;
  if (calcPattern.test(lower) && /[+\-*/]/.test(lower)) {
    const result = evaluateExpression(msg);
    if (!isNaN(result)) {
      const formatted =
        result >= 1000
          ? Math.round(result).toLocaleString("vi-VN")
          : result.toString();
      return ctx.reply(`📟 *RESULT*: ${formatted}`, { parse_mode: "Markdown" });
    }
  }

  // 2) VALUE MODE: "<amountExpr> <coin>" hoặc "val <amountExpr> <coin>"
  // amountExpr: số + k/m/b + +-*/...
  const simplePattern =
    /^([\d.kmb+\-*/()]+)\s+(sol|usdt|usd|vnd|bnb|btc|eth|ton|avax|doge)\b/i;
  const valPattern =
    /^val\s+([\d.kmb+\-*/()]+)\s+(sol|usdt|usd|vnd|bnb|btc|eth|ton|avax|doge)\b/i;

  if (simplePattern.test(lower) || valPattern.test(lower)) {
    try {
      await handleVal(ctx, msg);
    } catch (err) {
      console.error("❌ Error in text handler:", err.message);

      if (err.response && err.response.status === 429) {
        return ctx.reply(
          "⚠ API giá (CoinGecko) đang bị rate limit (429).\nĐợi vài giây rồi thử lại nha."
        );
      }

      ctx.reply("❌ Có lỗi xảy ra, thử lại sau.");
    }
  }
});

// Catch error global
bot.catch((err, ctx) => {
  console.error(`❌ Lỗi ngoài handler cho update ${ctx.updateType}:`, err);
});

bot.launch();
console.log("🚀 Telegram Crypto Value Bot running...");


