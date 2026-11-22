// =========================================================================
// USER CONFIGURATION (CUSTOMIZE THESE CONSTANTS)
// =========================================================================
const MESSAGE_FORMAT = "#{number} {confession}";
const TALLY_CONFESSION_LABEL = "say what you want to say";
const TALLY_MEDIA_LABEL = "got any pics or vids";
const SUPPORT_BOT_USERNAME = "@your_support_bot";

// =========================================================================
// INTERNAL LIMITS & CACHE DURATIONS
// =========================================================================
const MAX_CAPTION_LEN = 1000;
const MAX_TEXT_LEN = 4000;
const CACHE_TTL = 86400; // 24 hours auto-expiry in KV
const SWEAR_CACHE_TTL = 21600; // 6 hours in KV

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Setup Endpoint: Register Telegram Webhook
    if (request.method === "GET" && url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WORKER_ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      const webhookUrl = `${url.origin}/telegram`;
      const res = await telegramRequest(env.BOT_TOKEN, "setWebhook", {
        url: webhookUrl,
        drop_pending_updates: true,
        max_connections: 40,
        allowed_updates: ["callback_query", "edited_channel_post", "channel_post", "message"]
      });
      return new Response(JSON.stringify(res, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Tally Form Webhook Endpoint
    if (request.method === "POST" && url.pathname === "/tally") {
      try {
        const body = await request.json();
        ctx.waitUntil(handleTallyWebhook(body, env));
        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error("Tally Webhook Parse Error:", err);
        return new Response("Bad Request", { status: 400 });
      }
    }

    // 3. Telegram Bot Webhook Endpoint
    if (request.method === "POST" && url.pathname === "/telegram") {
      try {
        const update = await request.json();
        ctx.waitUntil(handleTelegramUpdate(update, env));
        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error("Telegram Webhook Parse Error:", err);
        return new Response("OK", { status: 200 });
      }
    }

    return new Response("Confession Publisher Worker Active", { status: 200 });
  }
};

// =========================================================================
// FORMATTING, SANITIZATION & TELEGRAM API HELPERS
// =========================================================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatConfession(number, cleanText) {
  if (!cleanText) {
    return MESSAGE_FORMAT
      .replaceAll("{number}", String(number))
      .replaceAll("{confession}", "")
      .trim();
  }
  return MESSAGE_FORMAT
    .replaceAll("{number}", String(number))
    .replaceAll("{confession}", () => cleanText)
    .trim();
}

function sanitizeUtf8(str) {
  if (!str) return "";
  if (typeof str.toWellFormed === "function") return str.toWellFormed();
  return str.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD"
  );
}

function getAdminIds(env) {
  return (env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function telegramRequest(botToken, method, payload, retries = 2) {
  const apiUrl = `https://api.telegram.org/bot${botToken}/${method}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!data.ok && data.error_code === 429 && data.parameters?.retry_after && attempt < retries) {
      const waitSec = Math.min(data.parameters.retry_after, 15);
      await sleep((waitSec + 0.5) * 1000);
      continue;
    }
    return data;
  }
}

async function telegramMultipart(botToken, method, formData, retries = 2) {
  const apiUrl = `https://api.telegram.org/bot${botToken}/${method}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(apiUrl, {
      method: "POST",
      body: formData
    });
    const data = await res.json();

    if (!data.ok && data.error_code === 429 && data.parameters?.retry_after && attempt < retries) {
      const waitSec = Math.min(data.parameters.retry_after, 15);
      await sleep((waitSec + 0.5) * 1000);
      continue;
    }
    return data;
  }
}

function calculateCooldownMs({ mediaCount = 0, textLength = 0, chunkCount = 1 }) {
  let cooldown = 3000;
  if (mediaCount >= 2) cooldown += mediaCount * 1500;
  if (chunkCount > 1) cooldown += (chunkCount - 1) * 2000;
  if (textLength > 1000) cooldown += 1000;
  return Math.min(cooldown, 15000);
}

function buildChannelPostUrl(channelId, messageId, chatUsername = null) {
  if (chatUsername) return `https://t.me/${chatUsername}/${messageId}`;
  const cleanChannelId = String(channelId).replace(/^-100/, "");
  return `https://t.me/c/${cleanChannelId}/${messageId}`;
}

// =========================================================================
// FIREBASE SWEAR WORD FILTER (6-HOUR KV CACHE)
// =========================================================================
async function getActiveSwearWords(env) {
  const cached = await env.MEJAKOPI_KV.get("ACTIVE_SWEAR_WORDS");
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (_) {}
  }

  try {
    const res = await fetch(`${env.FIREBASE_DB_URL}/swearwords.json`);
    if (res.ok) {
      const rawData = await res.json();
      if (rawData) {
        const wordsArray = Array.isArray(rawData) ? rawData : Object.values(rawData);
        const cleanedWords = wordsArray
          .map((w) => String(w).trim().toLowerCase())
          .filter((w) => w.length > 0);
        await env.MEJAKOPI_KV.put("ACTIVE_SWEAR_WORDS", JSON.stringify(cleanedWords), {
          expirationTtl: SWEAR_CACHE_TTL
        });
        return cleanedWords;
      }
    }
  } catch (err) {
    console.error("Firebase Fetch Error:", err);
  }
  return [];
}

async function manageSwearWord(env, action, word) {
  const cleanWord = word.trim().toLowerCase();
  if (!cleanWord) return "⚠️ Word cannot be empty!";

  const authUrl = `${env.FIREBASE_DB_URL}/swearwords.json?auth=${env.FIREBASE_DB_SECRET}`;
  let currentList = [];

  try {
    const res = await fetch(`${env.FIREBASE_DB_URL}/swearwords.json`);
    if (res.ok) {
      const raw = await res.json();
      if (raw) {
        currentList = Array.isArray(raw) ? raw : Object.values(raw);
        currentList = currentList.map((w) => String(w).trim().toLowerCase()).filter(Boolean);
      }
    }
  } catch (err) {
    return "❌ Failed to fetch database: " + err.message;
  }

  const wordExists = currentList.includes(cleanWord);

  if (action === "add") {
    if (wordExists) return `⚠️ \`${cleanWord}\` is already in the filter list!`;
    currentList.push(cleanWord);
    currentList.sort((a, b) => a.localeCompare(b));

    const updateRes = await fetch(authUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentList)
    });

    if (updateRes.ok) {
      await env.MEJAKOPI_KV.delete("ACTIVE_SWEAR_WORDS");
      return `✅ Added \`${cleanWord}\` to the filter list. (Total: ${currentList.length} words)`;
    }
    return `❌ Failed to update Firebase. Error code: ${updateRes.status}`;
  }

  if (action === "remove") {
    if (!wordExists) return `⚠️ The word \`${cleanWord}\` is not in the list!`;
    const updatedList = currentList.filter((w) => w !== cleanWord);

    const updateRes = await fetch(authUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedList)
    });

    if (updateRes.ok) {
      await env.MEJAKOPI_KV.delete("ACTIVE_SWEAR_WORDS");
      return `✅ Successfully removed \`${cleanWord}\` from the swear filter list!`;
    }
    return `❌ Failed to update Firebase. Error code: ${updateRes.status}`;
  }

  return "⚠️ Invalid action.";
}

function censorSwearWords(text, bannedWords) {
  if (!text || !Array.isArray(bannedWords) || bannedWords.length === 0) return text;
  let filtered = text;

  try {
    const sortedWords = [...bannedWords].sort((a, b) => b.length - a.length);
    for (const word of sortedWords) {
      const cleanWord = String(word).trim();
      if (!cleanWord) continue;
      const escapedWord = cleanWord.replace(/[.*+?^\${}()|[\]\\]/g, "\\\$&");
      const regex = new RegExp(`(^|[\\s.,!?;:])(${escapedWord})(?=[\\s.,!?;:]|$)`, "gi");

      filtered = filtered.replace(regex, (fullMatch, prefix, target) => {
        const censored = target.replace(/\S+/g, (w) => {
          if (w.length === 1) return "*";
          if (w.length === 2) return w[0] + "*";
          return w[0] + "*".repeat(w.length - 2) + w[w.length - 1];
        });
        return prefix + censored;
      });
    }
  } catch (err) {
    console.error("Censorship Error:", err);
  }
  return filtered;
}

// =========================================================================
// TEXT SPLITTING, CODE BLOCKS & MEDIA HELPERS
// =========================================================================
function splitLongTextWithDots(text, maxLength) {
  if (!text) return [""];
  if (text.length <= maxLength) return [text];

  const rawChunks = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(" ", maxLength);
    if (splitIdx <= 0) splitIdx = maxLength;
    rawChunks.push(remaining.substring(0, splitIdx).trim());
    remaining = remaining.substring(splitIdx).trim();
  }
  if (remaining.length > 0) rawChunks.push(remaining);

  return rawChunks.map((chunk, idx) => {
    let formatted = chunk;
    if (idx > 0) formatted = "..." + formatted;
    if (idx < rawChunks.length - 1) formatted = formatted + "...";
    return formatted;
  });
}

function stripContinuationDots(chunkText, isFirst, isLast) {
  let cleaned = chunkText || "";
  if (!isFirst && cleaned.startsWith("...")) cleaned = cleaned.substring(3);
  if (!isLast && cleaned.endsWith("...")) cleaned = cleaned.substring(0, cleaned.length - 3);
  return cleaned.trim();
}

function stripCodeBlockWrapper(text) {
  if (!text) return "";
  const raw = text.trim();
  const codeBlockMatch = raw.match(/```(?:[a-zA-Z0-9_-]*\r?\n)?([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1] !== undefined) {
    return codeBlockMatch[1].replace(/^\r?\n/, "").replace(/\r?\n\$/, "").trim();
  }
  return raw;
}

function detectUrlCategory(url, mimeType = "") {
  const lowerMime = (mimeType || "").toLowerCase();
  if (lowerMime.startsWith("image/")) return "photo";
  if (lowerMime.startsWith("video/")) return "video";

  const lowerUrl = url.toLowerCase().split("?")[0];
  if (lowerUrl.match(/\.(jpg|jpeg|png|webp|bmp|heic|heif|gif)\$/)) return "photo";
  if (lowerUrl.match(/\.(mp4|mov|avi|webm|mkv|m4v)\$/)) return "video";
  return "file";
}

// Writes at most ONE consolidated META_<finalMsgId> key only when needed
async function sendLongTextSequence(
  env,
  chatId,
  fullText,
  replyToMsgId,
  replyMarkup,
  adminMetaOptions,
  parseMode,
  wrapInCodeBlocks = false
) {
  const maxLen = wrapInCodeBlocks ? 3800 : MAX_TEXT_LEN;
  const chunks = splitLongTextWithDots(fullText, maxLen);
  let currentReplyId = replyToMsgId || null;
  let firstResponse = null;
  let lastResponse = null;
  const sentChunksMeta = [];

  for (let i = 0; i < chunks.length; i++) {
    const isLastChunk = i === chunks.length - 1;
    let chunkText = chunks[i];
    if (wrapInCodeBlocks) {
      chunkText = "```\n" + chunkText + "\n```";
    }

    const payload = {
      chat_id: chatId,
      text: chunkText
    };
    if (parseMode) payload.parse_mode = parseMode;
    if (currentReplyId) payload.reply_to_message_id = currentReplyId;
    if (isLastChunk && replyMarkup) payload.reply_markup = replyMarkup;

    let resJson = await telegramRequest(env.BOT_TOKEN, "sendMessage", payload);
    if (!resJson.ok && parseMode) {
      delete payload.parse_mode;
      resJson = await telegramRequest(env.BOT_TOKEN, "sendMessage", payload);
    }

    if (i === 0) firstResponse = resJson;
    lastResponse = resJson;

    if (lastResponse && lastResponse.ok && lastResponse.result) {
      currentReplyId = lastResponse.result.message_id;
      sentChunksMeta.push({
        message_id: currentReplyId,
        text: chunkText
      });
    }
  }

  if (adminMetaOptions && sentChunksMeta.length > 0) {
    const hasFiles = Array.isArray(adminMetaOptions.files) && adminMetaOptions.files.length > 0;
    const hasCustomCb = adminMetaOptions.cb && adminMetaOptions.cb !== "submit_post";
    if (sentChunksMeta.length > 1 || hasFiles || hasCustomCb) {
      const finalMsgId = sentChunksMeta[sentChunksMeta.length - 1].message_id;
      await env.MEJAKOPI_KV.put(
        `META_${finalMsgId}`,
        JSON.stringify({
          chunks: sentChunksMeta.length > 1 ? sentChunksMeta : null,
          files: adminMetaOptions.files || [],
          cb: adminMetaOptions.cb || "submit_post"
        }),
        { expirationTtl: CACHE_TTL }
      );
    }
  }

  return { firstResponse, lastResponse, chunkCount: chunks.length };
}

async function getFullAdminText(msg, env) {
  const messageId = msg.message_id;
  const rawMeta = await env.MEJAKOPI_KV.get(`META_${messageId}`);
  if (!rawMeta) return msg.text || msg.caption || "";

  const meta = JSON.parse(rawMeta);
  if (!Array.isArray(meta.chunks) || meta.chunks.length === 0) {
    return msg.text || msg.caption || "";
  }

  const chunkList = meta.chunks;
  chunkList[chunkList.length - 1].text =
    msg.text || msg.caption || chunkList[chunkList.length - 1].text;

  const cleanedParts = chunkList.map((item, idx) => {
    const unboxed = stripCodeBlockWrapper(item.text);
    return stripContinuationDots(unboxed, idx === 0, idx === chunkList.length - 1);
  });
  return cleanedParts.join(" ");
}

// =========================================================================
// TALLY WEBHOOK TO ADMIN PREVIEW
// =========================================================================
async function handleTallyWebhook(body, env) {
  const data = body?.data;
  if (!data || !Array.isArray(data.fields)) return;

  const submissionId = String(data.submissionId || data.responseId || "");
  if (submissionId) {
    const seenKey = `SEEN_SUB_${submissionId}`;
    const alreadySeen = await env.MEJAKOPI_KV.get(seenKey);
    if (alreadySeen) return;
    await env.MEJAKOPI_KV.put(seenKey, "1", { expirationTtl: 3600 });
  }

  const confessionTitle = TALLY_CONFESSION_LABEL.toLowerCase().trim();
  const photoQuestionTitle = TALLY_MEDIA_LABEL.toLowerCase().trim();

  let confession = "";
  let mediaEntries = [];

  for (const field of data.fields) {
    const label = (field.label || "").toLowerCase().trim();
    if (label.includes(confessionTitle) && typeof field.value === "string") {
      confession = field.value;
    } else if (label.includes(photoQuestionTitle) && field.value) {
      if (Array.isArray(field.value)) {
        for (const fileObj of field.value) {
          if (typeof fileObj === "string" && fileObj.startsWith("http")) {
            mediaEntries.push({ url: fileObj.trim(), mimeType: "" });
          } else if (fileObj && typeof fileObj.url === "string" && fileObj.url.startsWith("http")) {
            mediaEntries.push({ url: fileObj.url.trim(), mimeType: fileObj.mimeType || "" });
          }
        }
      } else if (typeof field.value === "string") {
        const splitUrls = field.value
          .split(/[\n,]+/)
          .map((u) => u.trim())
          .filter((u) => u.startsWith("http"));
        mediaEntries.push(...splitUrls.map((u) => ({ url: u, mimeType: "" })));
      }
    }
  }

  let messageText = confession.trim();
  if (!messageText && mediaEntries.length === 0) return;

  const bannedWords = await getActiveSwearWords(env);
  messageText = censorSwearWords(messageText, bannedWords);

  await sendPreviewToAdmin(env, env.PREVIEW_GROUP_ID, mediaEntries, messageText);
}

async function sendPreviewToAdmin(env, chatId, mediaEntries, messageText) {
  const mediaItems = [];
  const fileUrls = [];

  for (const entry of mediaEntries) {
    const url = typeof entry === "string" ? entry : entry.url;
    const mimeType = typeof entry === "string" ? "" : entry.mimeType;
    let category = detectUrlCategory(url, mimeType);
    let prefetchedBlob = null;

    if (category === "file") {
      try {
        const probeRes = await fetch(url);
        if (probeRes.ok) {
          const contentType = (probeRes.headers.get("content-type") || "").toLowerCase();
          const disposition = (probeRes.headers.get("content-disposition") || "").toLowerCase();

          if (
            contentType.startsWith("image/") ||
            disposition.match(/\.(jpg|jpeg|png|webp|bmp|heic|heif|gif)["';\s]?/)
          ) {
            category = "photo";
            prefetchedBlob = await probeRes.blob();
          } else if (
            contentType.startsWith("video/") ||
            disposition.match(/\.(mp4|mov|avi|webm|mkv|m4v)["';\s]?/)
          ) {
            category = "video";
            prefetchedBlob = await probeRes.blob();
          }
        }
      } catch (err) {
        console.error("Media probe error:", err);
      }
    }

    if (category === "photo" || category === "video") {
      mediaItems.push({ url, type: category, blob: prefetchedBlob });
    } else {
      fileUrls.push(url);
    }
  }

  const buildAdminKeyboard = (submitCallbackData) => {
    const keyboard = [];
    fileUrls.forEach((fUrl, idx) => {
      const label =
        fileUrls.length === 1 ? "📎 File Attachment (Admin Only)" : `📎 File #${idx + 1} (Admin Only)`;
      keyboard.push([{ text: label, url: fUrl }]);
    });
    keyboard.push([{ text: "✅ Submit / Post", callback_data: submitCallbackData }]);
    return { inline_keyboard: keyboard };
  };

  let cleanRawText = messageText ? sanitizeUtf8(messageText).trim() : "";
  cleanRawText = cleanRawText.replace(/^```[a-zA-Z0-9_-]*\r?\n?/, "").replace(/\r?\n?```$/, "");
  cleanRawText = cleanRawText.replace(/```/g, "'''").trim();

  const previewFormattedText = cleanRawText ? "```\n" + cleanRawText + "\n```" : "";
  const isCaptionTooLong = previewFormattedText.length > MAX_CAPTION_LEN;

  // CASE 1: ALBUM (2 to 10 media items)
  if (mediaItems.length >= 2) {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    const mediaGroupArray = [];

    const sliceItems = mediaItems.slice(0, 10);
    for (let idx = 0; idx < sliceItems.length; idx++) {
      const item = sliceItems[idx];
      const attachKey = `media_${idx}`;
      const blob = item.blob || (await (await fetch(item.url)).blob());
      formData.append(attachKey, blob, `${attachKey}.${item.type === "video" ? "mp4" : "jpg"}`);

      const mediaObj = {
        type: item.type,
        media: `attach://${attachKey}`
      };
      if (idx === 0 && previewFormattedText && !isCaptionTooLong) {
        mediaObj.caption = previewFormattedText;
        mediaObj.parse_mode = "Markdown";
      }
      mediaGroupArray.push(mediaObj);
    }

    formData.append("media", JSON.stringify(mediaGroupArray));
    const albumRes = await telegramMultipart(env.BOT_TOKEN, "sendMediaGroup", formData);

    if (!albumRes || !albumRes.ok || !Array.isArray(albumRes.result)) {
      return { ok: false, error: albumRes?.description || "Telegram sendMediaGroup failed" };
    }

    const albumMessages = albumRes.result;
    const firstAlbumMsgId = albumMessages[0].message_id;

    const trackedAlbum = albumMessages.map((m, idx) => {
      const isVid = Boolean(m.video || m.animation);
      const fId = m.photo
        ? m.photo[m.photo.length - 1].file_id
        : m.video
        ? m.video.file_id
        : m.animation.file_id;
      return {
        message_id: m.message_id,
        type: isVid ? "video" : "photo",
        file_id: fId,
        caption: idx === 0 ? m.caption || "" : ""
      };
    });

    await env.MEJAKOPI_KV.put(`ALBUM_DATA_${firstAlbumMsgId}`, JSON.stringify(trackedAlbum), {
      expirationTtl: CACHE_TTL
    });

    if (isCaptionTooLong) {
      const { lastResponse: capRes } = await sendLongTextSequence(
        env,
        chatId,
        cleanRawText,
        firstAlbumMsgId,
        buildAdminKeyboard(`submit_album_${firstAlbumMsgId}`),
        { files: fileUrls, cb: `submit_album_${firstAlbumMsgId}` },
        "Markdown",
        true
      );
      if (!capRes || !capRes.ok) {
        return { ok: false, error: capRes?.description || "Telegram caption sequence failed" };
      }
    } else {
      const ctrlRes = await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "🖼️ **Album Preview** *(Edit any image/caption above directly, then click Submit below)*",
        parse_mode: "Markdown",
        reply_to_message_id: firstAlbumMsgId,
        reply_markup: buildAdminKeyboard(`submit_album_${firstAlbumMsgId}`)
      });
      if (!ctrlRes || !ctrlRes.ok) {
        return { ok: false, error: ctrlRes?.description || "Telegram album control message failed" };
      }
    }
    return { ok: true };
  }

  // CASE 2: SINGLE MEDIA
  if (mediaItems.length === 1) {
    const item = mediaItems[0];
    const fileBlob = item.blob || (await (await fetch(item.url)).blob());
    const fileName = item.type === "video" ? "media.mp4" : "media.jpg";

    if (isCaptionTooLong) {
      const formData = new FormData();
      formData.append("chat_id", String(chatId));
      formData.append(item.type, fileBlob, fileName);

      const mediaRes = await telegramMultipart(
        env.BOT_TOKEN,
        item.type === "video" ? "sendVideo" : "sendPhoto",
        formData
      );

      if (!mediaRes || !mediaRes.ok || !mediaRes.result) {
        return { ok: false, error: mediaRes?.description || "Telegram media upload failed" };
      }

      const mediaMsgId = mediaRes.result.message_id;
      const fId =
        item.type === "video"
          ? (mediaRes.result.video || mediaRes.result.animation).file_id
          : mediaRes.result.photo[mediaRes.result.photo.length - 1].file_id;
      const trackedMedia = [
        {
          message_id: mediaMsgId,
          type: item.type,
          file_id: fId,
          caption: ""
        }
      ];

      await env.MEJAKOPI_KV.put(`ALBUM_DATA_${mediaMsgId}`, JSON.stringify(trackedMedia), {
        expirationTtl: CACHE_TTL
      });

      const { lastResponse: splitTextRes } = await sendLongTextSequence(
        env,
        chatId,
        cleanRawText,
        mediaMsgId,
        buildAdminKeyboard(`submit_split_${mediaMsgId}`),
        { files: fileUrls, cb: `submit_split_${mediaMsgId}` },
        "Markdown",
        true
      );
      if (!splitTextRes || !splitTextRes.ok) {
        return { ok: false, error: splitTextRes?.description || "Telegram split text failed" };
      }
      return { ok: true };
    }

    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    if (previewFormattedText) {
      formData.append("caption", previewFormattedText);
      formData.append("parse_mode", "Markdown");
    }
    formData.append("reply_markup", JSON.stringify(buildAdminKeyboard("submit_post")));
    formData.append(item.type, fileBlob, fileName);

    const sentRes = await telegramMultipart(
      env.BOT_TOKEN,
      item.type === "video" ? "sendVideo" : "sendPhoto",
      formData
    );

    if (!sentRes || !sentRes.ok || !sentRes.result) {
      return { ok: false, error: sentRes?.description || "Telegram media preview failed" };
    }

    if (fileUrls.length > 0) {
      await env.MEJAKOPI_KV.put(
        `META_${sentRes.result.message_id}`,
        JSON.stringify({ chunks: null, files: fileUrls, cb: "submit_post" }),
        { expirationTtl: CACHE_TTL }
      );
    }
    return { ok: true };
  }

  // CASE 3: TEXT ONLY
  const { lastResponse: textRes } = await sendLongTextSequence(
    env,
    chatId,
    cleanRawText || "(No text provided)",
    null,
    buildAdminKeyboard("submit_post"),
    { files: fileUrls, cb: "submit_post" },
    cleanRawText ? "Markdown" : null,
    Boolean(cleanRawText)
  );
  if (!textRes || !textRes.ok) {
    return { ok: false, error: textRes?.description || "Telegram sendMessage failed" };
  }
  return { ok: true };
}

// =========================================================================
// SUMMON SUBMISSION VIA GOOGLE SHEETS API
// =========================================================================
async function summonSubmission(env, targetSubId, includeMedia = true) {
  if (!env.GAS_SUMMON_API_URL || !env.GAS_API_KEY) {
    return "❌ Summon API URL or Auth Key is not configured in Cloudflare Worker secrets.";
  }

  try {
    const apiUrl = new URL(env.GAS_SUMMON_API_URL);
    apiUrl.searchParams.set("id", targetSubId);
    apiUrl.searchParams.set("key", env.GAS_API_KEY);

    const res = await fetch(apiUrl.toString(), { method: "GET" });

    if (!res.ok) {
      return `❌ Google Sheets API returned HTTP ${res.status}.`;
    }

    const result = await res.json();
    if (!result.ok) {
      return `⚠️ ${result.error || `Submission ID ${targetSubId} not found in Google Sheets.`}`;
    }

    let messageText = (result.confession || "").trim();
    let mediaEntries = [];

    if (includeMedia && Array.isArray(result.urls)) {
      mediaEntries = result.urls
        .map((u) => String(u).trim())
        .filter((u) => u.startsWith("http"))
        .map((u) => ({ url: u, mimeType: "" }));
    }

    if (!messageText && mediaEntries.length === 0) {
      if (!includeMedia) {
        return `⚠️ Submission \`${targetSubId}\` found, but it has no text (and media was disabled).`;
      }
      return `⚠️ Submission \`${targetSubId}\` found, but it has no text or media.`;
    }

    const bannedWords = await getActiveSwearWords(env);
    messageText = censorSwearWords(messageText, bannedWords);

    const previewRes = await sendPreviewToAdmin(env, env.PREVIEW_GROUP_ID, mediaEntries, messageText);
    if (previewRes && !previewRes.ok) {
      return `❌ Telegram rejected preview for \`${targetSubId}\`: \`${previewRes.error}\``;
    }

    const modeNotice = includeMedia ? "" : " *(Text-Only, Media Excluded)*";
    return `✅ Summoned \`${targetSubId}\`${modeNotice} successfully to the Preview Channel!`;
  } catch (err) {
    return `❌ Failed to summon submission: ${err.message}`;
  }
}

// =========================================================================
// TELEGRAM WEBHOOK ROUTER (DMs, Edits, Button Clicks)
// =========================================================================
async function handleTelegramUpdate(update, env) {
  const adminIds = getAdminIds(env);

  // ---------------------------------------------------------
  // CASE A: PRIVATE DMS (ADMIN COMMANDS vs USER REPLIES)
  // ---------------------------------------------------------
  const msg = update.message;
  if (msg && msg.text && msg.chat && msg.chat.type === "private") {
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    if (!adminIds.includes(chatId)) {
      const userHelpText =
        "👋 **Hi there!**\n\n" +
        "I am an automated backend bot for anonymous confessions.\n\n" +
        "📌 **How it works:**\n" +
        "• You cannot submit confessions directly through this chat.\n" +
        "• All submissions are handled anonymously via our submission form.\n" +
        "• Approved confessions will be posted to the main channel.\n" +
        `• If you need to contact moderators, please message ${SUPPORT_BOT_USERNAME}\n\n` +
        "Check our main channel for the submission form link!";

      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: userHelpText,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      });
      return;
    }

    if (text.startsWith("/swear")) {
      const parts = text.split(/\s+/);
      const action = parts[1] ? parts[1].toLowerCase() : "";

      if (action !== "add" && action !== "remove") {
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text:
            "📖 **How to use /swear:**\n" +
            "• `/swear add word or phrase with spaces`\n" +
            "• `/swear remove word or phrase with spaces`\n\n" +
            "*(Example: `/swear add bad phrase` — no quotes needed!)*",
          parse_mode: "Markdown"
        });
        return;
      }

      let targetWord = text.replace(/^\/swear\s+(add|remove)\s*/i, "").trim();
      targetWord = targetWord.replace(/^["'\\]+|["'\\]+$/g, "").trim();

      if (!targetWord) {
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ Please provide a word or phrase to add or remove.",
          parse_mode: "Markdown"
        });
        return;
      }

      const responseText = await manageSwearWord(env, action, targetWord);
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: responseText,
        parse_mode: "Markdown"
      });
      return;
    }

    if (text.startsWith("/setcounter ")) {
      const num = parseInt(text.replace("/setcounter ", "").trim(), 10);
      if (!isNaN(num)) {
        await env.MEJAKOPI_KV.put("POST_COUNTER", String(num));
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `✅ Post counter manually set to **${num}**. Next post will be #${num + 1}.`,
          parse_mode: "Markdown"
        });
      }
      return;
    }

    if (text.startsWith("/summon")) {
      const parts = text.split(/\s+/);
      const subIdToFind = parts[1] ? parts[1].trim() : "";

      if (!subIdToFind) {
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text:
            "📖 **How to use /summon:**\n" +
            "• `/summon <id>` *(Summon with media if available)*\n" +
            "• `/summon <id> false` *(Summon text-only, skip photos/videos)*\n\n" +
            "*(Example: `/summon wM8x9K false`)*",
          parse_mode: "Markdown"
        });
        return;
      }

      let includeMedia = true;
      if (parts[2]) {
        const mediaFlag = parts[2].trim().toLowerCase();
        if (["false", "0", "no", "hide", "off"].includes(mediaFlag)) {
          includeMedia = false;
        }
      }

      const summonResult = await summonSubmission(env, subIdToFind, includeMedia);
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: summonResult,
        parse_mode: "Markdown"
      });
      return;
    }

    if (text === "/panel") {
      const status = (await env.MEJAKOPI_KV.get("POSTING_STATUS")) || "ON";
      const btnText = status === "ON" ? "🟢 Posting: ON" : "🔴 Posting: OFF";

      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.PREVIEW_GROUP_ID,
        text: "🎛️ **Master Switch**\n*Pin this message!* Tap below to lock/unlock all Submit buttons across the bot.",
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: btnText, callback_data: "toggle_posting" }]]
        }
      });

      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "✅ Master Switch panel sent to the Preview Channel!"
      });
      return;
    }
  }

  // ---------------------------------------------------------
  // CASE B: ADMIN NATIVELY EDITED A MESSAGE OR ALBUM PHOTO
  // ---------------------------------------------------------
  const editedPost = update.edited_message || update.edited_channel_post;
  if (editedPost && String(editedPost.chat.id) === String(env.PREVIEW_GROUP_ID)) {
    if (editedPost.reply_markup) return;

    const msgId = editedPost.message_id;

    // 1. Check sequential message IDs (msgId down to msgId - 9) to locate album data
    for (let offset = 0; offset < 10; offset++) {
      const candidateFirstId = msgId - offset;
      const rawAlbum = await env.MEJAKOPI_KV.get(`ALBUM_DATA_${candidateFirstId}`);
      if (rawAlbum) {
        const albumList = JSON.parse(rawAlbum);
        const targetIdx = albumList.findIndex((item) => item.message_id === msgId);
        if (targetIdx !== -1) {
          if (editedPost.photo) {
            albumList[targetIdx].type = "photo";
            albumList[targetIdx].file_id = editedPost.photo[editedPost.photo.length - 1].file_id;
          } else if (editedPost.video || editedPost.animation) {
            albumList[targetIdx].type = "video";
            albumList[targetIdx].file_id = (editedPost.video || editedPost.animation).file_id;
          }
          if (editedPost.caption !== undefined) {
            albumList[targetIdx].caption = editedPost.caption;
          }
          await env.MEJAKOPI_KV.put(`ALBUM_DATA_${candidateFirstId}`, JSON.stringify(albumList), {
            expirationTtl: CACHE_TTL
          });
          return;
        }
      }
    }

    // 2. Check META_<msgId> (and forward up to +9 if an earlier text chunk was edited)
    for (let offset = 0; offset < 10; offset++) {
      const candidateFinalId = msgId + offset;
      const rawMeta = await env.MEJAKOPI_KV.get(`META_${candidateFinalId}`);
      if (rawMeta) {
        const meta = JSON.parse(rawMeta);
        if (Array.isArray(meta.chunks)) {
          const chunkIdx = meta.chunks.findIndex((c) => c.message_id === msgId);
          if (chunkIdx !== -1 && editedPost.text !== undefined) {
            meta.chunks[chunkIdx].text = editedPost.text;
            await env.MEJAKOPI_KV.put(`META_${candidateFinalId}`, JSON.stringify(meta), {
              expirationTtl: CACHE_TTL
            });
          }
        }

        if (offset === 0) {
          const isAlreadyPosted = await env.MEJAKOPI_KV.get(`POSTED_${msgId}`);
          if (!isAlreadyPosted) {
            const savedFiles = meta.files || [];
            const savedCallback = meta.cb || "submit_post";
            const restoredButtons = [];

            savedFiles.forEach((fUrl, idx) => {
              const label = savedFiles.length === 1 ? "📎 File Attachment" : `📎 File #${idx + 1}`;
              restoredButtons.push([{ text: label, url: fUrl }]);
            });
            restoredButtons.push([{ text: "✅ Submit / Post", callback_data: savedCallback }]);

            await telegramRequest(env.BOT_TOKEN, "editMessageReplyMarkup", {
              chat_id: env.PREVIEW_GROUP_ID,
              message_id: msgId,
              reply_markup: { inline_keyboard: restoredButtons }
            });
          }
        }
        return;
      }
    }

    // 3. Fallback button restoration for single-message previews that had no META key
    const isAlreadyPosted = await env.MEJAKOPI_KV.get(`POSTED_${msgId}`);
    if (!isAlreadyPosted) {
      await telegramRequest(env.BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: env.PREVIEW_GROUP_ID,
        message_id: msgId,
        reply_markup: {
          inline_keyboard: [[{ text: "✅ Submit / Post", callback_data: "submit_post" }]]
        }
      });
    }
    return;
  }

  // ---------------------------------------------------------
  // CASE C: INLINE BUTTON CLICKS
  // ---------------------------------------------------------
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data;
    const msg = cb.message;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const clickerId = String(cb.from.id);

    if (!adminIds.includes(clickerId)) {
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "You are not authorized to moderate.",
        show_alert: true
      });
      return;
    }

    if (data === "toggle_posting") {
      const currentStatus = (await env.MEJAKOPI_KV.get("POSTING_STATUS")) || "ON";
      const newStatus = currentStatus === "ON" ? "OFF" : "ON";
      await env.MEJAKOPI_KV.put("POSTING_STATUS", newStatus);

      const btnText = newStatus === "ON" ? "🟢 Posting: ON" : "🔴 Posting: OFF";
      await telegramRequest(env.BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [[{ text: btnText, callback_data: "toggle_posting" }]]
        }
      });
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: `Posting is now ${newStatus}!`
      });
      return;
    }

    if (data === "already_posted") {
      await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "⚠️ Already posted or currently processing!",
        show_alert: true
      });
      return;
    }

    // Submit / Post Handler
    if (data === "submit_post" || data.startsWith("submit_album_") || data.startsWith("submit_split_")) {
      const postingStatus = (await env.MEJAKOPI_KV.get("POSTING_STATUS")) || "ON";
      if (postingStatus === "OFF") {
        await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "🔴 Posting is OFF! Unlock Master Switch.",
          show_alert: true
        });
        return;
      }

      const alreadyLocked = await env.MEJAKOPI_KV.get(`POSTED_${messageId}`);
      if (alreadyLocked) {
        await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⏳ Already posted or currently processing!",
          show_alert: true
        });
        return;
      }

      await env.MEJAKOPI_KV.put(`POSTED_${messageId}`, "1", { expirationTtl: CACHE_TTL });

      const existingFileRows = [];
      if (msg.reply_markup && msg.reply_markup.inline_keyboard) {
        for (const row of msg.reply_markup.inline_keyboard) {
          const urlBtns = row.filter((btn) => Boolean(btn.url));
          if (urlBtns.length > 0) existingFileRows.push(urlBtns);
        }
      }

      const now = Date.now();
      const cooldownUntil = parseInt(
        (await env.MEJAKOPI_KV.get("CHANNEL_COOLDOWN_UNTIL")) || "0",
        10
      );
      const waitMs = cooldownUntil - now;
      let reservedCooldownUntil = now + 4000;

      if (waitMs > 0) {
        const waitSec = Math.ceil(waitMs / 1000);
        reservedCooldownUntil = cooldownUntil + 3500;
        await env.MEJAKOPI_KV.put("CHANNEL_COOLDOWN_UNTIL", String(reservedCooldownUntil), {
          expirationTtl: 60
        });

        await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: `⏳ Cooling down (${waitSec}s) to avoid Telegram rate limit...`
        });

        await telegramRequest(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              ...existingFileRows,
              [{ text: `⏳ Cooldown (${waitSec}s)...`, callback_data: "already_posted" }]
            ]
          }
        });

        await sleep(waitMs);
      } else {
        await env.MEJAKOPI_KV.put("CHANNEL_COOLDOWN_UNTIL", String(reservedCooldownUntil), {
          expirationTtl: 60
        });

        await telegramRequest(env.BOT_TOKEN, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "🚀 Posting..."
        });

        await telegramRequest(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              ...existingFileRows,
              [{ text: "⏳ Posting...", callback_data: "already_posted" }]
            ]
          }
        });
      }

      let currentCount = parseInt((await env.MEJAKOPI_KV.get("POST_COUNTER")) || "0", 10);
      currentCount++;

      let postResponse = null;
      let firstPostMsg = null;
      let postedMediaCount = 0;
      let postedTextLen = 0;
      let postedChunkCount = 1;

      try {
        // Sub-case 1: Album
        if (data.startsWith("submit_album_")) {
          const firstAlbumMsgId = data.replace("submit_album_", "");
          const rawAlbum = await env.MEJAKOPI_KV.get(`ALBUM_DATA_${firstAlbumMsgId}`);

          if (!rawAlbum) {
            await env.MEJAKOPI_KV.delete(`POSTED_${messageId}`);
            await restoreSubmitButton(env, chatId, messageId, existingFileRows, data);
            await telegramRequest(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: "❌ Error: Album memory expired.",
              reply_to_message_id: messageId
            });
            return;
          }

          const albumList = JSON.parse(rawAlbum);
          postedMediaCount = albumList.length;
          const isLongTextReply = !(msg.text && msg.text.startsWith("🖼️"));
          const rawConfessionText = isLongTextReply
            ? await getFullAdminText(msg, env)
            : albumList[0].caption || "";

          const cleanText = stripCodeBlockWrapper(rawConfessionText);
          const finalText = formatConfession(currentCount, cleanText);
          postedTextLen = finalText.length;

          if (isLongTextReply || finalText.length > MAX_CAPTION_LEN) {
            const cleanMedia = albumList.map((item) => ({
              type: item.type,
              media: item.file_id
            }));
            const albumPostRes = await telegramRequest(env.BOT_TOKEN, "sendMediaGroup", {
              chat_id: env.MAIN_CHANNEL_ID,
              media: cleanMedia
            });
            if (albumPostRes && albumPostRes.ok && Array.isArray(albumPostRes.result)) {
              firstPostMsg = albumPostRes.result[0];
              const seq = await sendLongTextSequence(
                env,
                env.MAIN_CHANNEL_ID,
                finalText,
                firstPostMsg.message_id,
                null,
                null
              );
              postResponse = seq.lastResponse;
              postedChunkCount = seq.chunkCount;
            } else {
              postResponse = albumPostRes;
            }
          } else {
            const mainChannelMedia = albumList.map((item, idx) => {
              const obj = { type: item.type, media: item.file_id };
              if (idx === 0 && finalText) obj.caption = finalText;
              return obj;
            });
            postResponse = await telegramRequest(env.BOT_TOKEN, "sendMediaGroup", {
              chat_id: env.MAIN_CHANNEL_ID,
              media: mainChannelMedia
            });
            if (postResponse && postResponse.ok && Array.isArray(postResponse.result)) {
              firstPostMsg = postResponse.result[0];
            }
          }
        }
        // Sub-case 2: Split Media (>1000 chars caption)
        else if (data.startsWith("submit_split_")) {
          const mediaMsgId = data.replace("submit_split_", "");
          const rawMedia = await env.MEJAKOPI_KV.get(`ALBUM_DATA_${mediaMsgId}`);
          const replyMsg = msg.reply_to_message;
          let mediaType = "photo";
          let fileId = null;

          if (rawMedia) {
            const parsed = JSON.parse(rawMedia)[0];
            mediaType = parsed.type;
            fileId = parsed.file_id;
          } else if (replyMsg) {
            if (replyMsg.video || replyMsg.animation) {
              mediaType = "video";
              fileId = (replyMsg.video || replyMsg.animation).file_id;
            } else if (replyMsg.photo) {
              fileId = replyMsg.photo[replyMsg.photo.length - 1].file_id;
            }
          }

          const cleanText = stripCodeBlockWrapper(await getFullAdminText(msg, env));
          const finalText = formatConfession(currentCount, cleanText);
          postedTextLen = finalText.length;
          postedMediaCount = fileId ? 1 : 0;

          if (fileId) {
            const firstRes = await telegramRequest(
              env.BOT_TOKEN,
              mediaType === "video" ? "sendVideo" : "sendPhoto",
              {
                chat_id: env.MAIN_CHANNEL_ID,
                [mediaType === "video" ? "video" : "photo"]: fileId
              }
            );
            if (firstRes && firstRes.ok && firstRes.result) {
              firstPostMsg = firstRes.result;
              const seq = await sendLongTextSequence(
                env,
                env.MAIN_CHANNEL_ID,
                finalText,
                firstPostMsg.message_id,
                null,
                null
              );
              postResponse = seq.lastResponse;
              postedChunkCount = seq.chunkCount;
            } else {
              postResponse = firstRes;
            }
          } else {
            const seq = await sendLongTextSequence(
              env,
              env.MAIN_CHANNEL_ID,
              finalText,
              null,
              null,
              null
            );
            postResponse = seq.lastResponse;
            firstPostMsg = seq.firstResponse?.result || null;
            postedChunkCount = seq.chunkCount;
          }
        }
        // Sub-case 3: Single Media or Text-Only
        else {
          const cleanText = stripCodeBlockWrapper(await getFullAdminText(msg, env));
          const finalPostText = formatConfession(currentCount, cleanText);
          postedTextLen = finalPostText.length;

          const photoFileId =
            msg.photo && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1].file_id : null;
          const videoFileId = msg.video ? msg.video.file_id : null;
          const animationFileId = msg.animation ? msg.animation.file_id : null;

          if ((photoFileId || videoFileId || animationFileId) && finalPostText.length > MAX_CAPTION_LEN) {
            postedMediaCount = 1;
            let mediaPostRes;
            if (photoFileId) {
              mediaPostRes = await telegramRequest(env.BOT_TOKEN, "sendPhoto", {
                chat_id: env.MAIN_CHANNEL_ID,
                photo: photoFileId
              });
            } else if (videoFileId) {
              mediaPostRes = await telegramRequest(env.BOT_TOKEN, "sendVideo", {
                chat_id: env.MAIN_CHANNEL_ID,
                video: videoFileId
              });
            } else {
              mediaPostRes = await telegramRequest(env.BOT_TOKEN, "sendAnimation", {
                chat_id: env.MAIN_CHANNEL_ID,
                animation: animationFileId
              });
            }

            if (mediaPostRes && mediaPostRes.ok && mediaPostRes.result) {
              firstPostMsg = mediaPostRes.result;
              const seq = await sendLongTextSequence(
                env,
                env.MAIN_CHANNEL_ID,
                finalPostText,
                firstPostMsg.message_id,
                null,
                null
              );
              postResponse = seq.lastResponse;
              postedChunkCount = seq.chunkCount;
            } else {
              postResponse = mediaPostRes;
            }
          } else if (photoFileId) {
            postedMediaCount = 1;
            postResponse = await telegramRequest(env.BOT_TOKEN, "sendPhoto", {
              chat_id: env.MAIN_CHANNEL_ID,
              photo: photoFileId,
              caption: finalPostText
            });
            firstPostMsg = postResponse?.result || null;
          } else if (videoFileId) {
            postedMediaCount = 1;
            postResponse = await telegramRequest(env.BOT_TOKEN, "sendVideo", {
              chat_id: env.MAIN_CHANNEL_ID,
              video: videoFileId,
              caption: finalPostText
            });
            firstPostMsg = postResponse?.result || null;
          } else if (animationFileId) {
            postedMediaCount = 1;
            postResponse = await telegramRequest(env.BOT_TOKEN, "sendAnimation", {
              chat_id: env.MAIN_CHANNEL_ID,
              animation: animationFileId,
              caption: finalPostText
            });
            firstPostMsg = postResponse?.result || null;
          } else {
            const seq = await sendLongTextSequence(
              env,
              env.MAIN_CHANNEL_ID,
              finalPostText,
              null,
              null,
              null
            );
            postResponse = seq.lastResponse;
            firstPostMsg = seq.firstResponse?.result || null;
            postedChunkCount = seq.chunkCount;
          }
        }

        // Handle Post Success
        if (postResponse && postResponse.ok) {
          await env.MEJAKOPI_KV.put("POST_COUNTER", String(currentCount));

          const nextCooldownMs = calculateCooldownMs({
            mediaCount: postedMediaCount,
            textLength: postedTextLen,
            chunkCount: postedChunkCount
          });
          const actualCooldownUntil = Date.now() + nextCooldownMs;
          if (actualCooldownUntil > reservedCooldownUntil + 500) {
            await env.MEJAKOPI_KV.put("CHANNEL_COOLDOWN_UNTIL", String(actualCooldownUntil), {
              expirationTtl: 60
            });
          }

          const targetMsgId = firstPostMsg?.message_id;
          const chatUsername = firstPostMsg?.chat?.username || null;
          const finalButton = targetMsgId
            ? {
                text: `✅ Posted as #${currentCount}`,
                url: buildChannelPostUrl(env.MAIN_CHANNEL_ID, targetMsgId, chatUsername)
              }
            : {
                text: `✅ Posted as #${currentCount}`,
                callback_data: "already_posted"
              };

          await telegramRequest(env.BOT_TOKEN, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [...existingFileRows, [finalButton]]
            }
          });
        } else {
          await env.MEJAKOPI_KV.delete(`POSTED_${messageId}`);
          await restoreSubmitButton(env, chatId, messageId, existingFileRows, data);
          const errReason = postResponse?.description || "Unknown Telegram API error";
          await telegramRequest(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: `❌ Failed to post: \`${errReason}\``,
            parse_mode: "Markdown",
            reply_to_message_id: messageId
          });
        }
      } catch (err) {
        await env.MEJAKOPI_KV.delete(`POSTED_${messageId}`);
        await restoreSubmitButton(env, chatId, messageId, existingFileRows, data);
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `❌ Unexpected error: \`${err.message}\``,
          parse_mode: "Markdown",
          reply_to_message_id: messageId
        });
      }
    }
  }
}

async function restoreSubmitButton(env, chatId, messageId, existingFileRows, callbackData) {
  await telegramRequest(env.BOT_TOKEN, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
      inline_keyboard: [
        ...existingFileRows,
        [{ text: "✅ Submit / Post", callback_data: callbackData }]
      ]
    }
  });
}