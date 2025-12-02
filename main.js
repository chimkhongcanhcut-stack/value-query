// main.js - Telegram Crypto Value Bot (CommonJS, auto-parse, cache, anti-429)

const { Telegraf } = require("telegraf");
const axios = require("axios");

// 👉 THAY TOKEN BOT CỦA BẠN VÀO ĐÂY
const BOT_TOKEN = "8421486324:AAFc0QpBWIuXvfVHfThZPIsE5d6rVq3a0j4";

if (!BOT_TOKEN || BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN") {
  console.error("❌ Chưa set BOT_TOKEN trong code!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ================== PRICE API + CACHE ==================

const API_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana,binancecoin,tether&vs_currencies=usd,vnd";

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

  lastPrices = {
    sol: res.data.solana,
    bnb: res.data.binancecoin,
    usdt: res.data.tether,
  };
  lastFetchTs = now;
  return lastPrices;
}

// ================== UTILS ==================

// convert text như: 100k -> 100000; 2m -> 2000000
function parseVND(str) {
  let num = parseFloat(str.replace(/[^0-9.]/g, ""));
  if (str.includes("k")) num *= 1000;
  if (str.includes("m")) num *= 1000000;
  return num;
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
        "- `2m vnd`",
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
    return ctx.reply("❌ Sai format. Ví dụ: `val 1 sol`, `100 usdt`, `2m vnd`");
  }

  const prices = await getPrices(); // dùng cache

  let usdValue, vndValue;

  if (coin === "vnd") {
    const vnd = parseVND(amountStr);
    if (!vnd || isNaN(vnd)) {
      return ctx.reply(
        "❌ Amount VND không hợp lệ (ví dụ: `100k vnd`, `2m vnd`, `500000 vnd`)."
      );
    }
    usdValue = (vnd / prices.usdt.vnd) * prices.usdt.usd;
    vndValue = vnd;
  } else {
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) {
      return ctx.reply("❌ Amount không hợp lệ.");
    }

    switch (coin) {
      case "sol":
        usdValue = amount * prices.sol.usd;
        vndValue = amount * prices.sol.vnd;
        break;
      case "bnb":
        usdValue = amount * prices.bnb.usd;
        vndValue = amount * prices.bnb.vnd;
        break;
      case "usdt":
      case "usd":
        usdValue = amount;
        vndValue = amount * (prices.usdt.vnd / prices.usdt.usd);
        break;
      default:
        return ctx.reply(
          "⚠ Coin chưa hỗ trợ.\n" +
            "Hiện hỗ trợ: `sol`, `bnb`, `usd/usdt`, `vnd`"
        );
    }
  }

  const sol = usdValue / prices.sol.usd;
  const bnb = usdValue / prices.bnb.usd;
  const usdt = usdValue; // 1 USDT ~ 1 USD

  return ctx.reply(
    `💰 *VALUE CHECK*\n\n` +
      `🇻🇳 VND: *${vndValue.toLocaleString("vi-VN")}₫*\n` +
      `💲 USD: *${usdValue.toFixed(2)}$*\n\n` +
      `🪙 SOL: *${sol.toFixed(4)} SOL*\n` +
      `🟡 BNB: *${bnb.toFixed(4)} BNB*\n` +
      `💵 USDT: *${usdt.toFixed(2)} USDT*`,
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
      "- `100 usdt`",
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
  const simplePattern = /^(\d+(\.\d+)?(k|m)?)\s+(sol|bnb|usdt|usd|vnd)\b/i;
  const valPattern = /^val\s+(\d+(\.\d+)?(k|m)?)\s+(sol|bnb|usdt|usd|vnd)\b/i;

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
