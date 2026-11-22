# 💬 Enquiries & Support Relay Bot — Complete Setup & Operations Guide

This guide covers deploying the **Enquiries & Support Relay Worker** (`enquiries-bot/worker.js`). It acts as a privacy-preserving helpdesk bridge between your community members and your private moderation team.

---

## 📋 Table of Contents
1. [How the Two-Way Relay Works](#1-how-the-two-way-relay-works)
2. [Step 1: Telegram Bot & Group Configuration](#2-step-1-telegram-bot--group-configuration)
3. [Step 2: Cloudflare Worker & KV Namespace Deployment](#3-step-2-cloudflare-worker--kv-namespace-deployment)
4. [Step 3: Webhook Registration](#4-step-3-webhook-registration)
5. [Step 4: Ticket Handling & Admin Commands](#5-step-4-ticket-handling--admin-commands)
6. [Privacy & Forward-Hiding Behavior](#6-privacy--forward-hiding-behavior)
7. [KV Storage Schema](#7-kv-storage-schema)
8. [Troubleshooting Matrix](#8-troubleshooting-matrix)

---

## 1. How the Two-Way Relay Works

1. **Anti-Spam Gate (`getChatMember`):** When a user messages your support bot in DM, the Worker verifies that the user is an active member of your public **Community Discussion Group** (`COMMUNITY_GROUP_ID`). Non-members and external spam bots are blocked automatically before any message reaches staff.
2. **Ticket Forwarding:** Verified user messages (text, photos, videos, documents, stickers, or voice notes) are forwarded into your **Private Staff Ticket Room** (`STAFF_GROUP_ID`), and a 30-day ticket mapping (`TICKET_<staffMsgId> -> <userId>`) is saved in Cloudflare KV.
3. **Anonymous Staff Replies:** Any moderator inside `STAFF_GROUP_ID` can reply directly to the forwarded message (or its ticket banner). The Worker relays the response back to the user's DM under the bot's identity—never exposing which admin replied.

---

## 2. Step 1: Telegram Bot & Group Configuration

### 2.1 Create a Separate Support Bot
1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and create a dedicated support bot (e.g., `@your_support_bot`). **Do not reuse the token from your Confession Publisher Bot.**
3. Copy the **HTTP API Token** and save it as **`BOT_TOKEN`**.
4. Send `/setprivacy` to `@BotFather`, select your support bot, and set it to **Disable** so the bot can read admin replies inside your Private Staff Ticket Room.

### 2.2 Configure Groups & Collect Numeric IDs
You need **two** Telegram groups:
1. **Community Discussion Group (`COMMUNITY_GROUP_ID`):** Your existing public discussion group linked to your main confession channel.
   * Add your support bot to this group (standard member or admin is fine—it only needs visibility to run `getChatMember`).
2. **Private Staff Ticket Room (`STAFF_GROUP_ID`):** A private group where moderators receive and answer support tickets.
   * Add your support bot as an **Administrator** with permission to **Send Messages**, **Delete Messages**, and **Pin Messages**.

**Retrieve Numeric IDs:**
* Use **[@RawDataBot](https://t.me/RawDataBot)** to get the `-100...` numeric IDs for both **`COMMUNITY_GROUP_ID`** and **`STAFF_GROUP_ID`**, plus comma-separated numeric User IDs for **`ADMIN_USER_IDS`**.

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

### 3.4 Configure Environment Secrets
Under **Settings -> Variables and Secrets**, add the following variables:

| Variable Name | Type | Example Value | Description |
| :--- | :--- | :--- | :--- |
| `BOT_TOKEN` | Secret | `9876543210:XYZabc...` | Support bot token from `@BotFather` |
| `WORKER_ADMIN_KEY` | Secret | `desk_setup_key_4410` | Password to authorize `/setup?key=...` |
| `STAFF_GROUP_ID` | Text | `-1002223334445` | Numeric Chat ID of the private staff ticket room |
| `COMMUNITY_GROUP_ID` | Text | `-1006667778889` | Numeric Chat ID of the public discussion group (for membership verification; leave blank to disable gate) |
| `ADMIN_USER_IDS` | Text | `123456789,987654321` | Comma-separated Telegram User IDs permitted to run `/ban` and `/unban` |
| `CHANNEL_HANDLE` | Text | `@your_channel` | Public channel handle displayed in user welcome/error prompts |

Click **Deploy** to save all variables.

---

## 4. Step 3: Webhook Registration

1. Visit your Worker's `/setup` endpoint in any browser:
   ```text
   <your-worker-url>/setup?key=YOUR_WORKER_ADMIN_KEY
   ```
2. Confirm you receive:
   ```json
   {
     "ok": true,
     "result": true,
     "description": "Webhook was set"
   }
   ```
3. Send `/start` to your support bot in a private DM to verify the welcome prompt.

---

## 5. Step 4: Ticket Handling & Admin Commands

### Replying to User Inquiries
1. When a verified user messages your bot, their message appears inside **`STAFF_GROUP_ID`** followed by (or attached to) a ticket control banner.
2. **To reply:** Swipe/right-click **Reply** on either the forwarded user message or the ticket banner in `STAFF_GROUP_ID` and send your text or media.
3. The bot automatically strips any internal command prefixes and delivers your reply to the user's DM, then reacts/confirms delivery in `STAFF_GROUP_ID`.
   * *Tip:* If multiple admins manage the desk, start your reply with a role tag (e.g., `mod:` or `admin:`) so users can distinguish staff responses without knowing personal identities.

### Staff Moderation Commands (Inside `STAFF_GROUP_ID`)
Reply directly to any user ticket message in `STAFF_GROUP_ID` with:

| Command | Action |
| :--- | :--- |
| **`/ban`** | Immediately adds the ticket sender's User ID to the permanent blocklist (`BLOCKED_<userId>`) and notifies staff. Future messages from that user are silently dropped. |
| **`/unban`** | Removes the ticket sender's User ID from the blocklist so they can submit inquiries again. |
| **`/status`** | Displays ticket metadata (ticket creation timestamp and blocklist status). |

---

## 6. Privacy & Forward-Hiding Behavior

* **How Telegram Forward Privacy Works:** Because the bot uses Telegram's native `forwardMessage` API to relay incoming tickets into `STAFF_GROUP_ID`:
  * Users with default Telegram privacy settings show a clickable forward link to their profile so admins can verify identity during takedown disputes.
  * Users who enable **Telegram Settings -> Privacy and Security -> Forwarded Messages -> Nobody** appear with an unlinked plain-text sender name—yet the bot still routes replies back to them seamlessly via its internal `TICKET_<staffMsgId>` KV mapping without revealing their User ID to staff.

---

## 7. KV Storage Schema

| KV Key Pattern | TTL | Purpose |
| :--- | :--- | :--- |
| `TICKET_<staffMsgId>` | `2592000s` (30d) | Maps every relayed message ID in `STAFF_GROUP_ID` back to the sender's `userId` for two-way replies. |
| `MEMBER_<userId>` | `900s` (15m) | Caches positive `getChatMember` verification results to avoid redundant Telegram API calls and KV writes. |
| `CD_<userId>` | `60s` (1m) | Enforces a short anti-flood cooldown between consecutive user DMs. |
| `BLOCKED_<userId>` | Permanent | Stores banned user IDs blocked via `/ban`. |

---

## 8. Troubleshooting Matrix

| Symptom | Root Cause | Resolution |
| :--- | :--- | :--- |
| **Bot tells valid group members to join the discussion group** | `COMMUNITY_GROUP_ID` is incorrect, or the bot is not inside that group. | Verify the `-100...` ID and ensure the bot is a member of the discussion group. |
| **Admin replies in `STAFF_GROUP_ID` are not sent to the user** | Admin sent a normal message instead of using Telegram's **Reply** feature, or Group Privacy is enabled in `@BotFather`. | Always **Reply** directly to the ticket message, and set `/setprivacy` -> **Disable** in `@BotFather`. |
| **`⚠️ Ticket expired` when replying to an old inquiry** | Ticket is older than 30 days (`2592000s` TTL). | Ask the user to send a fresh message to open a new 30-day ticket window. |

---

*☕ Brewed late at night with zero budget and too much caffeine.*