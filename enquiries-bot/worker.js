// =========================================================================
// ENQUIRIES & DIRECT CHAT RELAY WORKER (Cloudflare Workers + KV)
// =========================================================================
const TICKET_TTL = 2592000; // 30 days in KV
const MEMBER_CACHE_TTL = 900; // 15 minutes in KV
const USER_COOLDOWN_SEC = 3; // Anti-flood delay between user messages

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Setup Endpoint: Register Telegram Webhook + Secret Token
    if (request.method === "GET" && url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WORKER_ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      const webhookUrl = `${url.origin}/telegram`;
      const secretToken = await deriveTelegramSecret(env.WORKER_ADMIN_KEY);
      const res = await telegramRequest(env.BOT_TOKEN, "setWebhook", {
        url: webhookUrl,
        secret_token: secretToken,
        drop_pending_updates: true,
        max_connections: 40,
        allowed_updates: ["message"]
      });
      return new Response(JSON.stringify(res, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Telegram Bot Webhook Endpoint (Secret Token Verified)
    if (request.method === "POST" && url.pathname === "/telegram") {
      try {
        const expectedSecret = await deriveTelegramSecret(env.WORKER_ADMIN_KEY);
        const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (incomingSecret !== expectedSecret) {
          return new Response("Unauthorized", { status: 401 });
        }

        const update = await request.json();
        ctx.waitUntil(handleTelegramUpdate(update, env));
        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error("Telegram Webhook Parse Error:", err);
        return new Response("OK", { status: 200 });
      }
    }

    return new Response("Enquiries Relay Worker Active", { status: 200 });
  }
};

// =========================================================================
// SECURITY, ADMIN PARSING & TELEGRAM API HELPERS
// =========================================================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function deriveTelegramSecret(adminKey) {
  const data = new TextEncoder().encode(`tg-webhook:${adminKey || ""}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Supports both "Boss:123456789,Tauke:987654321" and "123456789,987654321"
function parseAdmins(env) {
  const adminMap = new Map();
  const entries = (env.ADMIN_USER_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const colonIdx = entry.lastIndexOf(":");
    if (colonIdx !== -1) {
      const label = entry.slice(0, colonIdx).trim();
      const id = entry.slice(colonIdx + 1).trim();
      if (id) adminMap.set(id, label || null);
    } else {
      adminMap.set(entry, null);
    }
  }
  return adminMap;
}

function isShowAdminNameEnabled(env) {
  return String(env.SHOW_ADMIN_NAME || "false").trim().toLowerCase() === "true";
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

async function isCommunityMember(env, userId) {
  if (!env.COMMUNITY_GROUP_ID) return true;

  const cacheKey = `MEMBER_${userId}`;
  const cached = await env.SUPPORT_KV.get(cacheKey);
  if (cached === "1") return true;

  const res = await telegramRequest(env.BOT_TOKEN, "getChatMember", {
    chat_id: env.COMMUNITY_GROUP_ID,
    user_id: Number(userId)
  });

  if (!res || !res.ok || !res.result) return false;

  const status = res.result.status;
  const isValid =
    status === "member" ||
    status === "administrator" ||
    status === "creator" ||
    (status === "restricted" && res.result.is_member === true);

  if (isValid) {
    await env.SUPPORT_KV.put(cacheKey, "1", { expirationTtl: MEMBER_CACHE_TTL });
  }
  return isValid;
}

async function relayStaffReply(env, targetUserId, msg, adminLabel) {
  const showName = isShowAdminNameEnabled(env) && Boolean(adminLabel);

  if (!showName) {
    return telegramRequest(env.BOT_TOKEN, "copyMessage", {
      chat_id: targetUserId,
      from_chat_id: env.STAFF_GROUP_ID,
      message_id: msg.message_id
    });
  }

  // Text reply with "Label: message" prefix
  if (msg.text) {
    return telegramRequest(env.BOT_TOKEN, "sendMessage", {
      chat_id: targetUserId,
      text: `${adminLabel}: ${msg.text}`
    });
  }

  // Media types that support caption replacement in copyMessage
  const supportsCaption = Boolean(
    msg.photo || msg.video || msg.document || msg.animation || msg.audio
  );

  if (supportsCaption) {
    const prefixedCaption = msg.caption
      ? `${adminLabel}: ${msg.caption}`
      : `${adminLabel}:`;

    return telegramRequest(env.BOT_TOKEN, "copyMessage", {
      chat_id: targetUserId,
      from_chat_id: env.STAFF_GROUP_ID,
      message_id: msg.message_id,
      caption: prefixedCaption
    });
  }

  // Stickers, voice notes, or video notes: send label header then copy message
  await telegramRequest(env.BOT_TOKEN, "sendMessage", {
    chat_id: targetUserId,
    text: `${adminLabel}:`
  });

  return telegramRequest(env.BOT_TOKEN, "copyMessage", {
    chat_id: targetUserId,
    from_chat_id: env.STAFF_GROUP_ID,
    message_id: msg.message_id
  });
}

// =========================================================================
// MAIN UPDATE ROUTER
// =========================================================================
async function handleTelegramUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.from || msg.from.is_bot) return;

  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const channelHandle = env.CHANNEL_HANDLE || "our main channel";

  // -----------------------------------------------------------------------
  // BRANCH A: USER DIRECT MESSAGE -> SILENT FORWARD TO STAFF ROOM
  // -----------------------------------------------------------------------
  if (msg.chat.type === "private") {
    const text = (msg.text || "").trim();

    if (text.startsWith("/start")) {
      const welcomeText =
        `👋 **Welcome to Support (${channelHandle})**\n\n` +
        "Send your question, technical bug report, or post removal request directly here and our moderation team will respond.\n\n" +
        "📌 **Guidelines:**\n" +
        "• Please remain polite and include exact confession numbers (`#123`) for takedown requests.\n" +
        "• Do not spam repeated messages—moderators are students and reply when available.\n\n" +
        "🔒 *Privacy Tip:* If you want your profile link hidden when forwarded to staff, set **Telegram Settings → Privacy and Security → Forwarded Messages** to **Nobody** before messaging.";

      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: userId,
        text: welcomeText,
        parse_mode: "Markdown"
      });
      return;
    }

    // 1. Permanent Blocklist Check
    const isBlocked = await env.SUPPORT_KV.get(`BLOCKED_${userId}`);
    if (isBlocked) return;

    // 2. Anti-Flood Cooldown Check
    const now = Date.now();
    const cdUntil = parseInt((await env.SUPPORT_KV.get(`CD_${userId}`)) || "0", 10);
    if (now < cdUntil) {
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: userId,
        text: "⏳ Please wait a few seconds before sending another message."
      });
      return;
    }

    // 3. Community Group Membership Verification Gate
    const allowed = await isCommunityMember(env, userId);
    if (!allowed) {
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: userId,
        text:
          `⛔ **Access Restricted**\n\n` +
          `You must be an active member of the **${channelHandle}** community discussion group before messaging here.`,
        parse_mode: "Markdown"
      });
      return;
    }

    await env.SUPPORT_KV.put(`CD_${userId}`, String(now + USER_COOLDOWN_SEC * 1000), {
      expirationTtl: 60
    });

    // 4. Native Forward to Staff Room (Completely silent on user's end)
    const fwdRes = await telegramRequest(env.BOT_TOKEN, "forwardMessage", {
      chat_id: env.STAFF_GROUP_ID,
      from_chat_id: userId,
      message_id: msg.message_id
    });

    if (!fwdRes || !fwdRes.ok || !fwdRes.result) {
      console.error("forwardMessage failed:", JSON.stringify(fwdRes));
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: userId,
        text: "❌ Unable to deliver your message right now. Please try again later."
      });
      return;
    }

    const forwardedMsgId = fwdRes.result.message_id;
    const ticketData = JSON.stringify({
      userId,
      createdAt: new Date().toISOString()
    });

    await env.SUPPORT_KV.put(`TICKET_${forwardedMsgId}`, ticketData, {
      expirationTtl: TICKET_TTL
    });
    return;
  }

  // -----------------------------------------------------------------------
  // BRANCH B: STAFF ROOM -> DIRECT REPLY OR MODERATION COMMAND
  // -----------------------------------------------------------------------
  if (chatId === String(env.STAFF_GROUP_ID)) {
    if (!msg.reply_to_message) return;

    const repliedMsgId = msg.reply_to_message.message_id;
    const rawTicket = await env.SUPPORT_KV.get(`TICKET_${repliedMsgId}`);
    const text = (msg.text || "").trim();
    const adminMap = parseAdmins(env);

    if (!rawTicket) {
      if (text.startsWith("/ban") || text.startsWith("/unban") || text.startsWith("/info")) {
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.STAFF_GROUP_ID,
          text: "⚠️ Conversation expired (older than 30 days) or invalid target message.",
          reply_to_message_id: msg.message_id
        });
      }
      return;
    }

    const ticket = JSON.parse(rawTicket);
    const targetUserId = ticket.userId;

    if (text === "/ban") {
      if (!adminMap.has(userId)) {
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.STAFF_GROUP_ID,
          text: "⛔ Only authorized admins can run `/ban`.",
          parse_mode: "Markdown",
          reply_to_message_id: msg.message_id
        });
        return;
      }
      await env.SUPPORT_KV.put(`BLOCKED_${targetUserId}`, "1");
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.STAFF_GROUP_ID,
        text: "🚫 User has been **permanently blocked**.",
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id
      });
      return;
    }

    if (text === "/unban") {
      if (!adminMap.has(userId)) {
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.STAFF_GROUP_ID,
          text: "⛔ Only authorized admins can run `/unban`.",
          parse_mode: "Markdown",
          reply_to_message_id: msg.message_id
        });
        return;
      }
      await env.SUPPORT_KV.delete(`BLOCKED_${targetUserId}`);
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.STAFF_GROUP_ID,
        text: "✅ User has been **unblocked**.",
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id
      });
      return;
    }

    if (text === "/info") {
      const isBanned = Boolean(await env.SUPPORT_KV.get(`BLOCKED_${targetUserId}`));
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.STAFF_GROUP_ID,
        text:
          `📋 **User Info**\n` +
          `• **Message Sent:** \`${ticket.createdAt}\`\n` +
          `• **Account State:** ${isBanned ? "🚫 Banned" : "🟢 Active"}`,
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id
      });
      return;
    }

    const adminLabel = adminMap.get(userId) || null;
    const relayRes = await relayStaffReply(env, targetUserId, msg, adminLabel);

    if (!relayRes || !relayRes.ok) {
      const errReason = relayRes?.description || "User may have blocked the bot";
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.STAFF_GROUP_ID,
        text: `❌ Failed to deliver reply: \`${errReason}\``,
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id
      });
    }
  }
}