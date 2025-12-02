// main.js - Telegram Crypto Value Bot (CommonJS, auto-parse, cache, multi-coin, tỷ, no-BNB output)

const { Telegraf } = require("telegraf");
const axios = require("axios");

// 👉 THAY TOKEN BOT CỦA BẠN VÀO ĐÂY
const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";

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
  usd: "tether",      // treat usd like usdt
  bnb: "binancecoin",
  btc: "bitcoin",
  eth: "ethereum",
  ton: "toncoin",
  avax: "avalanche-2",
  doge: "dogecoin",
};

// build ids string for API
const COIN_IDS = Array.from(new Set(Object.values(COIN_MAP))).join(",");

// ================== PRICE API + CACHE ==================

const API_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${COIN_IDS}&vs_currencies=usd,vnd`;

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

  if (!data.tether || !data.tether.usd || !data.tether.vnd) {
    throw new Error("Missing tether price data from CoinGecko");
  }

  const fxVndPerUsd = data.tether.vnd / data.tether.usd;

  lastPrices = {
    raw: data,        // full data by id
    fxVndPerUsd,      // global FX: VND per 1 USD
  };

  lastFetchTs = now;
  return lastPrices;
}

// ================== UTILS ==================

// convert text như: 100k -> 100000; 2m -> 2000000; 1b -> 1,000,000,000; 1 tỷ -> 1,000,000,000
function parseVND(str) {
  const s = str.toLowerCase();
  let num = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return NaN;

  if (s.includes("k")) num *= 1_000;
  if (s.includes("m")) num *= 1_000_000;
  if (s.includes("b") || s.includes("ty") || s.includes("tỷ")) num *= 1_000_000_000;

  return num;
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

// ================== CORE HANDLER ==================

async function handleVal(ctx, rawInput) {
  const raw = rawInput.trim().toLowerCase();
  if (!raw) {
    return ctx.reply(
      "📌 Format: `val <amount> <coin>` hoặc chỉ `<amount> <coin>`\n" +
        "Ví dụ:\n" +
        "- `val 1 sol`\n" +
        "- `100 usdt`\n" +
        "- `500k vnd`\n" +
        "- `2m vnd`\n" +
        "- `1b vnd`\n" +
        "- `0.01 btc`\n" +
        "- `0.5 eth`",
      { parse_mode: "Markdown" }
    );
  }

  // Cho phép: "val 1 sol" hoặc "1 sol"
  let text = raw;
  if (text.startsWith("val ")) {
    text = text.slice(4).trim();
  }

  const [amountStr, coin] = text.split(" ");
  if (!amountStr || !coin) {
    return ctx.reply(
      "❌ Sai format. Ví dụ: `val 1 sol`, `100 usdt`, `2m vnd`, `1b vnd`, `0.01 btc`"
    );
  }

  const prices = await getPrices(); // dùng cache

  let usdValue;
  let vndValue;

  // Trường hợp input là VND
  if (coin === "vnd") {
    const vnd = parseVND(amountStr);
    if (!vnd || isNaN(vnd)) {
      return ctx.reply(
        "❌ Amount VND không hợp lệ (ví dụ: `100k vnd`, `2m vnd`, `1b vnd`, `500000 vnd`)."
      );
    }
    usdValue = vnd / prices.fxVndPerUsd;
    vndValue = vnd;
  } else {
    const amount = parseFloat(amountStr.replace(/,/g, ""));
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
    vndValue = usdValue * prices.fxVndPerUsd;
  }

  // từ tổng USD value → suy ra SOL & USDT
  const solPrice = prices.raw["solana"]?.usd;
  if (!solPrice) {
    throw new Error("Missing SOL price");
  }

  const solAmount = usdValue / solPrice;
  const usdtAmount = usdValue; // 1 USDT ~ 1 USD

  return ctx.reply(
    `💰 *VALUE CHECK*\n\n` +
      `🇻🇳 VND: *${Math.round(vndValue).toLocaleString("vi-VN")}₫*\n` +
      `💲 USD: *${usdValue.toFixed(2)}$*\n\n` +
      `🪙 SOL: *${solAmount.toFixed(4)} SOL*\n` +
      `💵 USDT: *${usdtAmount.toFixed(2)} USDT*`,
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
      "- `2m vnd`\n" +
      "- `1b vnd`\n" +
      "- `100 usdt`\n" +
      "- `0.01 btc`\n" +
      "- `0.5 eth`",
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

  // match pattern "<amount> <coin>" hoặc "val <amount> <coin>"
  // amount: số, số.k/m/b, có thể có thập phân
  const simplePattern =
    /^(\d+(\.\d+)?(k|m|b)?)\s+(sol|usdt|usd|vnd|bnb|btc|eth|ton|avax|doge)\b/i;
  const valPattern =
    /^val\s+(\d+(\.\d+)?(k|m|b)?)\s+(sol|usdt|usd|vnd|bnb|btc|eth|ton|avax|doge)\b/i;

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
