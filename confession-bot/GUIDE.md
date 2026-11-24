# 📨 Confession Publisher Bot — Complete Setup & Operations Guide

This guide walks through deploying the **Confession Publisher Worker** (`confession-bot/worker.js`) from scratch. Follow every step in sequence—skipping permissions or misnaming bindings will cause silent webhook rejections.

---

## 📋 Table of Contents
1. [Prerequisites & Architecture Notes](#1-prerequisites--architecture-notes)
2. [Step 1: Telegram Bot & Channels Setup](#2-step-1-telegram-bot--channels-setup)
3. [Step 2: Firebase Realtime Database (Profanity Filter)](#3-step-2-firebase-realtime-database-profanity-filter)
4. [Step 3: Google Sheets & Apps Script (`/summon` Backup API)](#4-step-3-google-sheets--apps-script-summon-backup-api)
5. [Step 4: Cloudflare Worker & KV Namespace Deployment](#5-step-4-cloudflare-worker--kv-namespace-deployment)
6. [Step 5: Webhook Registration & Verification](#6-step-5-webhook-registration--verification)
7. [Step 6: Tally Form Webhook Integration](#7-step-6-tally-form-webhook-integration)
8. [Step 7: Customizing Post Formatting & Labels](#8-step-7-customizing-post-formatting--labels)
9. [Admin Command Reference](#9-admin-command-reference)
10. [KV Storage Schema & Quota Engineering](#10-kv-storage-schema--quota-engineering)
11. [Troubleshooting Matrix](#11-troubleshooting-matrix)

---

## 1. Prerequisites & Architecture Notes

Before starting, prepare the following free-tier accounts (ideally isolated under a dedicated operational email for privacy):
* **Telegram Account** (to create the bot via `@BotFather` and retrieve numeric IDs)
* **Cloudflare Account** (Free Plan — includes 100,000 Worker requests/day and 1,000 KV writes/day)
* **Firebase Account** (Spark Free Plan — Realtime Database)
* **Tally.so Account** (Free Plan — supports native Webhooks and Google Sheets sync)
* **Google Account** (for Google Sheets + Google Apps Script)

> **Operational Security Notes (`*.workers.dev` & Webhook Verification):**
> * Do **not** attach a personal custom domain to this Worker if you want to remain anonymous. Attaching a subdomain automatically logs an SSL certificate in public Certificate Transparency logs (`crt.sh`), linking the bot to your root domain. Keep the default `https://<worker-name>.<subdomain>.workers.dev` URL.
> * Because Cloudflare's Cache API (`caches.default`) is disabled on `*.workers.dev` routes, this Worker stores all transient locks and cooldowns directly in Cloudflare KV.
> * Both inbound webhook routes are cryptographically verified: `/telegram` checks `X-Telegram-Bot-Api-Secret-Token` (derived from `WORKER_ADMIN_KEY`), and `/tally` verifies `Tally-Signature` via HMAC-SHA256 whenever `TALLY_SIGNING_SECRET` is configured.

---

## 2. Step 1: Telegram Bot & Channels Setup

### 2.1 Create the Bot
1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts to set a display name and username (e.g., `@your_confession_bot`).
3. Copy the **HTTP API Token** (format: `1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ`). Save this as **`BOT_TOKEN`**.

### 2.2 Create Two Telegram Channels & Collect Numeric IDs
You need **two** separate Telegram channels:
1. **Main Public Channel (`MAIN_CHANNEL_ID`):** A public channel where approved confessions are published for your community.
2. **Private Staff Preview Channel (`PREVIEW_GROUP_ID`):** A private channel accessible *only* to moderators where incoming submissions appear for review and live editing before publication.

**Configure Bot Permissions:**
* Add your bot as an **Administrator** in **both** channels.
* Grant the bot permission to **Post Messages**, **Edit Messages**, and **Delete Messages** in both channels. *(Because Telegram channels automatically send `edited_channel_post` events to admin bots, you do not need to change Group Privacy settings in `@BotFather`.)*

**Retrieve Numeric Chat & User IDs:**
1. Message **[@userinfobot](https://t.me/userinfobot)** or **[@RawDataBot](https://t.me/RawDataBot)** to get your personal numeric Telegram User ID (e.g., `123456789`). If you have multiple admins, collect all their IDs separated by commas (`123456789,987654321`). Save this as **`ADMIN_USER_IDS`**.
2. Forward one post from your **Main Public Channel** and one post from your **Private Preview Channel** to `@RawDataBot` (or inspect `forward_from_chat.id`).
3. Copy both numeric IDs. Channel IDs always start with `-100` (e.g., `-1001987654321`). Save these as **`MAIN_CHANNEL_ID`** and **`PREVIEW_GROUP_ID`**.

---

## 3. Step 2: Firebase Realtime Database (Profanity Filter)

The Worker fetches banned words/phrases from Firebase Realtime Database and caches them in Cloudflare KV for 6 hours (`21600` seconds) to minimize external latency and KV writes.

### 3.1 Create the Database
1. Go to the [Firebase Console](https://console.firebase.google.com/) and click **Add project**.
2. In the left sidebar, navigate to **Build -> Realtime Database** and click **Create Database**.
3. Select the datacenter closest to your users (e.g., `asia-southeast1` for Southeast Asia) and start in **Locked Mode**.
4. Copy the database root URL displayed at the top of the Data tab (e.g., `https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app`). **Remove any trailing slash.** Save this as **`FIREBASE_DB_URL`**.

### 3.2 Import Seed Data
1. In the Realtime Database **Data** tab, hover over your root database URL and click the **`+`** icon to add a child node.
2. Enter **`swearwords`** as the **Name** and any temporary text (e.g., `init`) as the **Value**, then click **Add**.
3. Click directly on the **`swearwords`** key name so your view opens inside `/swearwords`.
4. Click the three-dot menu (**`⋮`**) on the right -> **Import JSON**, and upload [`swearwords.example.json`](../swearwords.example.json).
5. Verify that `/swearwords` now displays indexed items (`0: "badword1"`, `1: "badword2"`, etc.).

> **Shortcut:** You can also skip manual JSON importing completely—once your bot is running, simply DM `/swear add testword` to your bot and it will automatically create the `/swearwords` array in Firebase for you.

### 3.3 Configure Security Rules
1. Switch to the **Rules** tab in Realtime Database and replace the rules with:
   ```json
   {
     "rules": {
       "swearwords": {
         ".read": true,
         ".write": false
       }
     }
   }
   ```
2. Click **Publish**. Public reads allow fast unauthenticated GET requests from your Worker, while `.write: false` blocks unauthorized modifications unless authenticated with your database secret.

### 3.4 Generate Database Secret
1. Click the **Gear Icon (⚙️)** next to *Project Overview* -> **Project settings**.
2. Open the **Service accounts** tab -> click **Database secrets** in the left sub-menu.
3. Hover over your project's secret key and click **Show**, then copy it. Save this as **`FIREBASE_DB_SECRET`**.

---

## 4. Step 3: Google Sheets & Apps Script (`/summon` Backup API)

If a webhook times out or a submission is accidentally deleted from the preview room, admins can recover any entry by running `/summon <submission_id>` in a private DM with the bot.

### 4.1 Link Tally to Google Sheets
1. Open your confession form in [Tally.so](https://tally.so/).
2. Go to the **Integrations** tab and connect **Google Sheets**.
3. Open the newly created Google Sheet and note the exact column headers:
   * Tally automatically creates a **`Submission ID`** column (usually Column A).
   * Ensure your confession text column header contains `say what you want to say` (case-insensitive) and your media upload column header contains `got any pics or vids` (or update the matching strings in `SummonApi.gs` and `worker.js`).

### 4.2 Deploy `SummonApi.gs`
1. Inside your Google Sheet, click **Extensions -> Apps Script**.
2. Delete any default `myFunction()` code and paste the entire contents of [`confession-bot/SummonApi.gs`](./SummonApi.gs).
3. Invent a strong random password (e.g., `summon_secret_98x72kLmP`) and set it as `API_KEY` at the top of `SummonApi.gs` (or in **Project Settings -> Script Properties** as `GAS_API_KEY`). Save this exact string as **`GAS_API_KEY`**.
4. Click **Deploy -> New deployment**.
5. Click the gear icon next to *Select type* and choose **Web app**.
6. Configure:
   * **Description:** `Confession Summon API`
   * **Execute as:** `Me (your-email@gmail.com)`
   * **Who has access:** `Anyone` *(Required so Cloudflare Workers can reach the endpoint; requests are protected by your `GAS_API_KEY` check).*
7. Click **Deploy**, authorize permissions when prompted, and copy the **Web app URL** (must end in `/exec`). Save this as **`GAS_SUMMON_API_URL`**.

---

## 5. Step 4: Cloudflare Worker & KV Namespace Deployment

### 5.1 Create the KV Namespace
1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. In the left sidebar, expand **Storage & Databases -> KV** (or **Workers & Pages -> KV**).
3. Click **Create a namespace**, name it `CONFESSION_KV`, and click **Add**.

### 5.2 Create & Deploy the Worker
1. Go to **Workers & Pages -> Create -> Create Worker**.
2. Give it a neutral name (e.g., `kopi-dispatcher`) and click **Deploy**.
3. Click **Edit code**, delete the sample `fetch` handler, paste the entire contents of [`confession-bot/worker.js`](./worker.js), and click **Deploy** in the top-right corner.

### 5.3 Bind the KV Namespace
1. Go back to your Worker's overview page and open **Settings -> Bindings** (or **Variables and Secrets**).
2. Click **Add -> KV Namespace**.
3. Set **Variable name** to **`MEJAKOPI_KV`** *(must match the exact `env.MEJAKOPI_KV` binding name used in `worker.js`)* and select the **`CONFESSION_KV`** namespace you created in Step 5.1.
4. Click **Save / Deploy**.

### 5.4 Configure Environment Variables & Secrets
Under **Settings -> Variables and Secrets**, add the variables below (click **Encrypt** on sensitive tokens):

| Variable Name | Type | Required? | Example Value | Description |
| :--- | :--- | :--- | :--- | :--- |
| `BOT_TOKEN` | Secret | **Yes** | `1234567890:ABCdef...` | Telegram Bot API token from `@BotFather` |
| `WORKER_ADMIN_KEY` | Secret | **Yes** | `my_setup_pass_9921` | Authorizes `/setup?key=...` and derives Telegram's webhook `secret_token` |
| `ADMIN_USER_IDS` | Secret / Text | **Yes** | `123456789,987654321` | Comma-separated Telegram User IDs allowed to approve posts & run admin commands |
| `PREVIEW_GROUP_ID` | Secret / Text | **Yes** | `-1001112223334` | Numeric Chat ID of the private admin preview channel/group |
| `MAIN_CHANNEL_ID` | Secret / Text | **Yes** | `-1005556667778` | Numeric Chat ID of the public confession channel |
| `FIREBASE_DB_URL` | Secret / Text | **Yes** | `https://proj.firebaseio.com` | Firebase RTDB root URL (no trailing `/`) |
| `FIREBASE_DB_SECRET` | Secret | **Yes** | `aBcDeFgHiJkLmNoPqRsTuVwXyZ` | Firebase RTDB legacy secret token |
| `TALLY_SIGNING_SECRET` | Secret | Optional | `whsec_a1b2c3d4e5...` | Signing secret from Tally webhook settings to verify `Tally-Signature` (leave unset if disabled in Tally) |
| `GAS_SUMMON_API_URL` | Secret / Text | Optional | `https://script.google.com/.../exec` | Google Apps Script Web App URL for `/summon` |
| `GAS_API_KEY` | Secret | Optional | `summon_secret_98x72kLmP` | Shared secret matching `SummonApi.gs` |

Click **Deploy** after adding or modifying variables so the live Worker loads the updated environment.

---

## 6. Step 5: Webhook Registration & Verification

1. Copy your Worker's live `*.workers.dev` URL (e.g., `https://kopi-dispatcher.your-subdomain.workers.dev`).
2. Open your browser and visit:
   ```text
   <your-worker-url>/setup?key=YOUR_WORKER_ADMIN_KEY
   ```
   *(This automatically derives a SHA-256 `secret_token` from `WORKER_ADMIN_KEY` and registers it with Telegram so spoofed requests to `/telegram` are rejected with `401 Unauthorized`.)*
3. You should receive a JSON response confirming registration:
   ```json
   {
     "ok": true,
     "result": true,
     "description": "Webhook was set"
   }
   ```
4. Open Telegram, DM `/panel` to your bot, and confirm that the **🎛️ Master Switch** (`🟢 Posting: ON`) appears in your Preview Room. Pin that message.

---

## 7. Step 6: Tally Form Webhook Integration

1. Open your confession form in [Tally.so](https://tally.so/) and ensure it contains:
   * A **Long Answer** field whose label includes `say what you want to say` (or your custom `TALLY_CONFESSION_LABEL`).
   * *(Optional)* A **File Upload** field whose label includes `got any pics or vids` (or your custom `TALLY_MEDIA_LABEL`).
2. Publish your Tally form, then go to the **Integrations** tab and click **Connect** next to **Webhooks**.
3. Paste your Worker's `/tally` endpoint:
   ```text
   <your-worker-url>/tally
   ```
4. *(Optional)* If you enable **Signing secret** in Tally's webhook settings, copy the generated secret and save it as **`TALLY_SIGNING_SECRET`** in your Cloudflare Worker secrets (then click **Deploy**). Leave `TALLY_SIGNING_SECRET` unset in Cloudflare if you do not enable it in Tally.
5. Save and submit a test entry on your Tally form. Within 1–3 seconds, a formatted preview with an **📤 Submit / Post** button will appear in your Preview Room.

---

## 8. Step 7: Customizing Post Formatting & Labels

At the top of `confession-bot/worker.js`, you can customize post templates, form labels, and the enquiries bot handle without modifying core logic:

```javascript
const MESSAGE_FORMAT = "#{number} {confession}";
const TALLY_CONFESSION_LABEL = "say what you want to say";
const TALLY_MEDIA_LABEL = "got any pics or vids";
const SUPPORT_BOT_USERNAME = "@helpkopi_bot";
```

* **`MESSAGE_FORMAT`:** Supports `{number}` and `{confession}` tokens. Examples:
  * Standard inline: `"#{number} {confession}"` -> `#104 Hello campus`
  * Multi-line header: `"#{number}\n\n{confession}"`
  * With channel tag footer: `"#{number} {confession}\n\n— @your_channel"`

---

## 9. Admin Command Reference

Send these commands via **Private DM** to your bot (only IDs listed in `ADMIN_USER_IDS` are authorized; all other users receive an automated info reply directing them to `SUPPORT_BOT_USERNAME`):

| Command | Syntax Example | Description |
| :--- | :--- | :--- |
| **`/panel`** | `/panel` | Sends the global **Master Switch** (`🟢 Posting: ON` / `🔴 Posting: OFF`) to the Preview Room to lock/unlock all Submit buttons simultaneously. |
| **`/setcounter`** | `/setcounter 500` | Sets the current confession counter to `500` (next published post will be `#501`). |
| **`/swear list`** | `/swear list` | Displays all currently active words and phrases in the profanity filter list. |
| **`/swear add`** | `/swear add bad phrase` | Adds a word or multi-word phrase to Firebase RTDB (sorted alphabetically) and invalidates the 6-hour KV cache immediately. |
| **`/swear remove`** | `/swear remove bad phrase` | Removes a word or phrase from Firebase RTDB and clears the KV cache. |
| **`/summon`** | `/summon wM8x9K` | Fetches submission `wM8x9K` from Google Sheets via `SummonApi.gs` and sends it to the Preview Room. |
| **`/summon` (text-only)** | `/summon wM8x9K false` | Summons submission `wM8x9K` while stripping media attachments (useful if a user uploaded an oversized >50 MB video). |

### Live Editing Workflow in Preview Room
* **Edit Text:** Natively edit any preview message (or any chunk of a multi-part long confession) in Telegram. The bot automatically restores the **📤 Submit / Post** button and publishes your edited version.
* **Edit Album Photos/Captions:** Natively replace any image/video or edit the first item's caption inside a 2–10 item preview album before clicking **📤 Submit / Post**.

---

## 10. KV Storage Schema & Quota Engineering

This Worker is engineered to stay well under Cloudflare's **1,000 KV writes/day** free-tier ceiling (~4–5 writes per post = **200–250+ posts/day**):

| KV Key Pattern | TTL | Purpose |
| :--- | :--- | :--- |
| `POST_COUNTER` | Permanent | Stores the latest published confession number. |
| `POSTING_STATUS` | Permanent | Stores `"ON"` or `"OFF"` for the `/panel` Master Switch. |
| `ACTIVE_SWEAR_WORDS` | `21600s` (6h) | Cached JSON array of lowercase banned words from Firebase. |
| `SEEN_SUB_<submissionId>` | `3600s` (1h) | Prevents duplicate previews if Tally retries a webhook delivery. |
| `ALBUM_DATA_<firstMsgId>` | `129600s` (36h) | Stores `file_id`s and captions for 2–10 item albums and split media. |
| `META_<finalMsgId>` | `129600s` (36h) | Consolidated JSON holding multi-chunk text history, file attachment URLs, and callback state. |
| `POSTED_<messageId>` | `129600s` (36h) | Atomic single-write lock preventing duplicate posts when two admins click Submit simultaneously. |
| `GLOBAL_SUBMIT_LOCK` | `30s` | Short-lived lock preventing concurrent publishing collisions across different posts. |
| `CHANNEL_COOLDOWN_UNTIL` | `60s` (1m) | Timestamp lock enforcing dynamic spacing between channel posts to prevent Telegram `429` rate limits. |

---

## 11. Troubleshooting Matrix

| Symptom | Root Cause | Resolution |
| :--- | :--- | :--- |
| **Tally submission never appears in Preview Room** | Field label mismatch, `TALLY_SIGNING_SECRET` mismatch (`401`), or oversized attachment (>50 MB Telegram / >128 MB Worker RAM limit). | Verify `TALLY_CONFESSION_LABEL` and `TALLY_SIGNING_SECRET`, or recover text-only via `/summon <id> false`. |
| **Bot ignores all DMs, edits, and button clicks after deploying** | Telegram webhook `secret_token` not registered yet (returning `401 Unauthorized` on `/telegram`). | Visit `<your-worker-url>/setup?key=YOUR_WORKER_ADMIN_KEY` once in your browser. |
| **Clicking `📤 Submit / Post` does nothing** | User ID is missing from `ADMIN_USER_IDS`, or Master Switch (`/panel`) is set to `🔴 Posting: OFF`. | Verify your numeric ID in `ADMIN_USER_IDS` and check the pinned Master Switch. |
| **Native message edit causes buttons to disappear permanently** | Bot lacks **Edit Messages** permission in `PREVIEW_GROUP_ID`, or `/setprivacy` is enabled in `@BotFather`. | Promote bot to full Admin in the Preview Room and disable Group Privacy in `@BotFather`. |
| **`/summon` returns `HTTP 401` or `Unauthorized`** | `GAS_API_KEY` in Cloudflare does not match `SummonApi.gs`. | Ensure both secrets match character-for-character and re-deploy the Apps Script Web App. |
| **`Error: Album memory expired`** | Preview sat unapproved in the Preview Room for >36 hours (`CACHE_TTL = 129600`). | Re-import the entry using `/summon <submission_id>`. |

---

*☕ Brewed late at night with zero budget and too much caffeine.*