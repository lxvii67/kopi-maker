// =========================================================================
// ENQUIRIES & SUPPORT RELAY WORKER (Cloudflare Workers + KV)
// =========================================================================
const TICKET_TTL = 2592000; // 30 days in KV
const MEMBER_CACHE_TTL = 900; // 15 minutes in KV
const USER_COOLDOWN_SEC = 5; // Anti-flood delay between user messages

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
        allowed_updates: ["message"]
      });
      return new Response(JSON.stringify(res, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Telegram Bot Webhook Endpoint
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

    return new Response("Enquiries & Support Relay Worker Active", { status: 200 });
  }
};

// =========================================================================
// TELEGRAM API & HELPERS
// =========================================================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getAdminIds(env) {
  return (env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function telegramRequest(botToken, method, payload, retries = 2) {
  const apiUrl = `[https://api.telegram.org/bot$](https://api.telegram.org/bot$){botToken}/${method}`;
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
  // If COMMUNITY_GROUP_ID is blank, membership gate is disabled
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
  // BRANCH A: USER DIRECT MESSAGE -> PRIVATE STAFF TICKET ROOM
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
          `You must be an active member of the **${channelHandle}** community discussion group before messaging support.`,
        parse_mode: "Markdown"
      });
      return;
    }

    // Set short anti-flood cooldown
    await env.SUPPORT_KV.put(`CD_${userId}`, String(now + USER_COOLDOWN_SEC * 1000), {
      expirationTtl: 60
    });

    // 4. Native Forward to Staff Ticket Room (preserves user's Forward Privacy settings)
    const fwdRes = await telegramRequest(env.BOT_TOKEN, "forwardMessage", {
      chat_id: env.STAFF_GROUP_ID,
      from_chat_id: userId,
      message_id: msg.message_id
    });

    if (!fwdRes || !fwdRes.ok || !fwdRes.result) {
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

    // 5. Post Compact Ticket Control Banner in Staff Room
    const privacyLabel = fwdRes.result.forward_from
      ? "👤 Forward Privacy: Visible"
      : "🔒 Forward Privacy: Hidden";

    const bannerRes = await telegramRequest(env.BOT_TOKEN, "sendMessage", {
      chat_id: env.STAFF_GROUP_ID,
      text:
        `🎫 **New Support Ticket** (${privacyLabel})\n` +
        `*Reply directly to the user's message or this banner to respond.*\n` +
        `Commands: \`/ban\` • \`/unban\` • \`/status\``,
      parse_mode: "Markdown",
      reply_to_message_id: forwardedMsgId
    });

    if (bannerRes && bannerRes.ok && bannerRes.result) {
      await env.SUPPORT_KV.put(`TICKET_${bannerRes.result.message_id}`, ticketData, {
        expirationTtl: TICKET_TTL
      });
    }

    await telegramRequest(env.BOT_TOKEN, "sendMessage", {
      chat_id: userId,
      text: "✅ Your message has been forwarded to the moderation team. Please wait patiently for a reply."
    });
    return;
  }

  // -----------------------------------------------------------------------
  // BRANCH B: STAFF TICKET ROOM -> ANONYMOUS REPLY OR MODERATION COMMAND
  // -----------------------------------------------------------------------
  if (chatId === String(env.STAFF_GROUP_ID)) {
    // Ignore normal staff chat messages that are not replies to a ticket
    if (!msg.reply_to_message) return;

    const repliedMsgId = msg.reply_to_message.message_id;
    const rawTicket = await env.SUPPORT_KV.get(`TICKET_${repliedMsgId}`);
    const text = (msg.text || "").trim();
    const adminIds = getAdminIds(env);

    if (!rawTicket) {
      if (text.startsWith("/ban") || text.startsWith("/unban") || text.startsWith("/status")) {
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.STAFF_GROUP_ID,
          text: "⚠️ Ticket expired (older than 30 days) or invalid target message.",
          reply_to_message_id: msg.message_id
        });
      }
      return;
    }

    const ticket = JSON.parse(rawTicket);
    const targetUserId = ticket.userId;

    // Staff Command: /ban
    if (text === "/ban") {
      if (!adminIds.includes(userId)) {
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
        text: "🚫 User has been **permanently blocked** from messaging support.",
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id
      });
      return;
    }

    // Staff Command: /unban
    if (text === "/unban") {
      if (!adminIds.includes(userId)) {
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
        text: "✅ User has been **unblocked** and may submit inquiries again.",
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id
      });
      return;
    }

    // Staff Command: /status
    if (text === "/status") {
      const isBanned = Boolean(await env.SUPPORT_KV.get(`BLOCKED_${targetUserId}`));
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.STAFF_GROUP_ID,
        text:
          `📋 **Ticket Status**\n` +
          `• **Opened:** \`${ticket.createdAt}\`\n` +
          `• **Account State:** ${isBanned ? "🚫 Banned" : "🟢 Active"}`,
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id
      });
      return;
    }

    // Relay Staff Reply (supports text, photos, videos, documents, stickers, voice, etc.)
    const copyRes = await telegramRequest(env.BOT_TOKEN, "copyMessage", {
      chat_id: targetUserId,
      from_chat_id: env.STAFF_GROUP_ID,
      message_id: msg.message_id
    });

    if (copyRes && copyRes.ok) {
      const reactRes = await telegramRequest(env.BOT_TOKEN, "setMessageReaction", {
        chat_id: env.STAFF_GROUP_ID,
        message_id: msg.message_id,
        reaction: [{ type: "emoji", emoji: "👍" }]
      });
      if (!reactRes || !reactRes.ok) {
        await telegramRequest(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.STAFF_GROUP_ID,
          text: "✅ Reply delivered.",
          reply_to_message_id: msg.message_id
        });
      }
    } else {
      const errReason = copyRes?.description || "User may have blocked the bot";
      await telegramRequest(env.BOT_TOKEN, "sendMessage", {
        chat_id: env.STAFF_GROUP_ID,
        text: `❌ Failed to deliver reply: \`${errReason}\``,
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id
      });
    }
  }
}