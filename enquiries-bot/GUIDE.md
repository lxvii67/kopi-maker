# 💬 Enquiries & Direct Chat Relay Bot — Complete Setup & Operations Guide

This guide covers deploying the **Enquiries & Direct Chat Relay Worker** (`enquiries-bot/worker.js`). It acts as a lightweight, privacy-preserving two-way bridge between your community members and your private moderation team without ticket-system clutter.

---

## 📋 Table of Contents
1. [How the Two-Way Relay Works](#1-how-the-two-way-relay-works)
2. [Step 1: Telegram Bot & Group Configuration](#2-step-1-telegram-bot--group-configuration)
3. [Step 2: Cloudflare Worker & KV Namespace Deployment](#3-step-2-cloudflare-worker--kv-namespace-deployment)
4. [Step 3: Webhook Registration](#4-step-3-webhook-registration)
5. [Step 4: Replying & Admin Commands](#5-step-4-replying--admin-commands)
6. [Privacy & Forward-Hiding Behavior](#6-privacy--forward-hiding-behavior)
7. [KV Storage Schema](#7-kv-storage-schema)
8. [Troubleshooting Matrix](#8-troubleshooting-matrix)

---

## 1. How the Two-Way Relay Works

1. **Anti-Spam Gate (`getChatMember`):** When a user messages your bot in DM, the Worker verifies that the user is an active member of your **Community Discussion Group** (`COMMUNITY_GROUP_ID`). Non-members and external spam bots are blocked before any message reaches staff. *(Leave `COMMUNITY_GROUP_ID` blank to allow anyone to message.)*
2. **Silent Direct Forwarding:** Verified user messages (text, photos, videos, documents, stickers, or voice notes) are forwarded directly into your **Private Staff Room** (`STAFF_GROUP_ID`) with no extra ticket banners or automated confirmation spam, and a 30-day conversation mapping (`TICKET_<staffMsgId> -> <userId>`) is saved in Cloudflare KV.
3. **Configurable Admin Replies:** Any moderator inside `STAFF_GROUP_ID` can reply directly to a forwarded message. Depending on `SHOW_ADMIN_NAME`, the Worker relays the response either completely anonymously or prefixed with the replying admin's label (e.g., `Boss:` or `Tauke:`).

---

## 2. Step 1: Telegram Bot & Group Configuration

### 2.1 Create a Separate Enquiries Bot
1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and create a dedicated enquiries bot (e.g., `@your_enquiries_bot`). **Do not reuse the token from your Confession Publisher Bot.**
3. Copy the **HTTP API Token** and save it as **`BOT_TOKEN`**.
4. Send `/setprivacy` to `@BotFather`, select your enquiries bot, and set it to **Disable** so the bot can read admin replies inside your Private Staff Room.

### 2.2 Configure Groups & Collect Numeric IDs
You need **two** Telegram groups (or just `STAFF_GROUP_ID` if you disable the membership gate):
1. **Community Discussion Group (`COMMUNITY_GROUP_ID`):** Your existing public/community discussion group linked to your main confession channel.
   * Add your enquiries bot to this group (standard member or admin is fine—it only needs visibility to run `getChatMember`).
2. **Private Staff Room (`STAFF_GROUP_ID`):** A private group where admins receive and reply to user messages.
   * Add your enquiries bot as an **Administrator** with permission to **Send Messages** and **Delete Messages**.

**Retrieve Numeric IDs:**
* Use **[@RawDataBot](https://t.me/RawDataBot)** to get the `-100...` numeric IDs for **`STAFF_GROUP_ID`** (and **`COMMUNITY_GROUP_ID`** if used), plus numeric Telegram User IDs for **`ADMIN_USER_IDS`**.

---

## 3. Step 2: Cloudflare Worker & KV Namespace Deployment

### 3.1 Create the KV Namespace
1. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), go to **Storage & Databases -> KV**.
2. Click **Create a namespace**, name it `SUPPORT_KV`, and click **Add**.

### 3.2 Create & Deploy the Worker
1. Go to **Workers & Pages -> Create -> Create Worker**.
2. Name it (e.g., `kopi-desk`) and click **Deploy**.
3. Click **Edit code**, paste the entire contents of [`enquiries-bot/worker.js`](./worker.js), and click **Deploy**.

### 3.3 Bind the KV Namespace
1. Open your Worker's **Settings -> Bindings** (or **Variables and Secrets**).
2. Click **Add -> KV Namespace**.
3. Set **Variable name** to **`SUPPORT_KV`** *(must match `env.SUPPORT_KV` in `worker.js`)* and select your **`SUPPORT_KV`** namespace.

### 3.4 Configure Environment Variables & Secrets
Under **Settings -> Variables and Secrets**, add the following variables:

| Variable Name | Type | Required | Example Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `BOT_TOKEN` | Secret | **Yes** | `9876543210:XYZabc...` | Enquiries bot token from `@BotFather` |
| `WORKER_ADMIN_KEY` | Secret | **Yes** | `desk_setup_key_4410` | Authorizes `/setup?key=...` and derives `X-Telegram-Bot-Api-Secret-Token` |
| `STAFF_GROUP_ID` | Text | **Yes** | `-1002223334445` | Numeric Chat ID of the private staff room |
| `ADMIN_USER_IDS` | Text | **Yes** | `Boss:123456789,Tauke:987654321` *(or `123456789,987654321`)* | Authorizes `/ban` & `/unban` and maps optional reply prefixes |
| `SHOW_ADMIN_NAME` | Text | Optional | `true` or `false` | Set `true` to prefix replies with admin labels (`Boss: ...`); defaults to `false` (anonymous) |
| `COMMUNITY_GROUP_ID` | Text | Optional | `-1006667778889` | Discussion group ID for membership verification (leave blank to disable gate) |
| `CHANNEL_HANDLE` | Text | Optional | `@your_channel` | Channel handle shown in `/start` and access notices (leave blank for private channels; defaults to `"our main channel"`) |

Click **Deploy** to save all variables.

---

## 4. Step 3: Webhook Registration

1. Visit your Worker's `/setup` endpoint in any browser:
   ```text
   <your-worker-url>/setup?key=YOUR_WORKER_ADMIN_KEY
   ```
   *(This automatically derives and registers the `X-Telegram-Bot-Api-Secret-Token` header so spoofed `/telegram` POST requests are rejected with `401 Unauthorized`.)*
2. Confirm you receive:
   ```json
   {
     "ok": true,
     "result": true,
     "description": "Webhook was set"
   }
   ```
3. Send `/start` to your enquiries bot in a private DM to verify the welcome prompt.

---

## 5. Step 4: Replying & Admin Commands

### Replying to Users
1. When a verified user messages your bot, their message forwards directly into **`STAFF_GROUP_ID`**.
2. **To reply:** Swipe/right-click **Reply** on the forwarded user message in `STAFF_GROUP_ID` and send your text, photo, video, document, sticker, or voice note.
3. The bot delivers your reply silently to the user's DM without cluttering `STAFF_GROUP_ID` with confirmation messages or reactions (an error notice is only sent if delivery fails).
   * **Admin Prefix Behavior:** When `SHOW_ADMIN_NAME` is `true` and your ID has a label in `ADMIN_USER_IDS` (e.g., `Boss:123456789`), text messages and media captions are prefixed with `Boss: `. When `SHOW_ADMIN_NAME` is `false` (or omitted), all replies are sent anonymously via `copyMessage`.

### Staff Moderation Commands (Inside `STAFF_GROUP_ID`)
Reply directly to any forwarded user message in `STAFF_GROUP_ID` with:

| Command | Access | Action |
| :--- | :--- | :--- |
| **`/info`** | Any staff in `STAFF_GROUP_ID` | Displays conversation metadata (message timestamp and active/banned state). |
| **`/ban`** | `ADMIN_USER_IDS` only | Permanently blocks the user (`BLOCKED_<userId>`) from messaging the bot. Future messages are silently dropped. |
| **`/unban`** | `ADMIN_USER_IDS` only | Removes the permanent block so the user can message again. |

---

## 6. Privacy & Forward-Hiding Behavior

* **How Telegram Forward Privacy Works:** Because the bot uses Telegram's native `forwardMessage` API to relay incoming DMs into `STAFF_GROUP_ID`:
  * Users with default Telegram privacy settings show a clickable forward link to their profile so admins can verify identity during takedown disputes.
  * Users who enable **Telegram Settings -> Privacy and Security -> Forwarded Messages -> Nobody** appear with an unlinked plain-text sender name—yet the bot still routes replies back to them seamlessly via its internal `TICKET_<staffMsgId>` KV mapping without revealing their User ID to staff.

---

## 7. KV Storage Schema

| KV Key Pattern | TTL | Purpose |
| :--- | :--- | :--- |
| `TICKET_<staffMsgId>` | `2592000s` (30d) | Maps every forwarded message ID in `STAFF_GROUP_ID` back to the sender's `userId` for two-way replies. |
| `MEMBER_<userId>` | `900s` (15m) | Caches positive `getChatMember` verification results to avoid redundant Telegram API calls and KV writes. |
| `CD_<userId>` | `60s` (1m) | Enforces a 3-second (`USER_COOLDOWN_SEC = 3`) anti-flood cooldown between consecutive user DMs. |
| `BLOCKED_<userId>` | Permanent | Stores banned user IDs blocked via `/ban`. |

---

## 8. Troubleshooting Matrix

| Symptom | Root Cause | Resolution |
| :--- | :--- | :--- |
| **User receives `❌ Unable to deliver your message right now`** | `STAFF_GROUP_ID` is incorrect/missing, group upgraded to a supergroup (`-100...` prefix), or bot lacks Send Messages permission in `STAFF_GROUP_ID`. | Verify the exact `-100...` group ID via `@RawDataBot`, ensure the enquiries bot is an admin in `STAFF_GROUP_ID`, and re-deploy. |
| **Bot tells valid group members to join the discussion group** | `COMMUNITY_GROUP_ID` is incorrect, or the bot is not inside that group. | Verify the `-100...` ID and ensure the bot is a member of the discussion group (or leave `COMMUNITY_GROUP_ID` blank). |
| **Admin replies in `STAFF_GROUP_ID` are not sent to the user** | Admin sent a normal message instead of using Telegram's **Reply** feature, or Group Privacy is enabled in `@BotFather`. | Always **Reply** directly to the forwarded user message, and set `/setprivacy` -> **Disable** in `@BotFather`. |
| **`⚠️ Conversation expired` when replying to an old message** | Message is older than 30 days (`2592000s` TTL). | Ask the user to send a fresh message to start a new 30-day mapping window. |

---

*☕ Brewed late at night with zero budget and too much caffeine.*