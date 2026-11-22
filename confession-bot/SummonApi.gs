// =========================================================================
// GOOGLE APPS SCRIPT — /summon BACKUP LOOKUP API
// Deploy as Web App: Execute as "Me", Who has access: "Anyone"
// =========================================================================

// Set GAS_API_KEY in Project Settings -> Script Properties, or replace the fallback below
const API_KEY =
  PropertiesService.getScriptProperties().getProperty("GAS_API_KEY") ||
  "CHANGE_ME_TO_YOUR_GAS_API_KEY";

const SUBMISSION_ID_HEADER = "submission id";
const CONFESSION_HEADER = "say what you want to say";
const MEDIA_HEADER = "got any pics or vids";

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const providedKey = String(params.key || "").trim();
    const targetId = String(params.id || "").trim();

    if (!API_KEY || API_KEY === "CHANGE_ME_TO_YOUR_GAS_API_KEY") {
      return jsonResponse({
        ok: false,
        error: "Server API key is not configured in SummonApi.gs."
      });
    }

    if (!providedKey || providedKey !== API_KEY) {
      return jsonResponse({
        ok: false,
        error: "Unauthorized: Invalid API key."
      });
    }

    if (!targetId) {
      return jsonResponse({
        ok: false,
        error: "Missing submission ID parameter (?id=...)."
      });
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (!sheet) {
      return jsonResponse({
        ok: false,
        error: "No worksheet found in the linked spreadsheet."
      });
    }

    const rows = sheet.getDataRange().getDisplayValues();
    if (rows.length < 2) {
      return jsonResponse({
        ok: false,
        error: "Spreadsheet is empty."
      });
    }

    const headers = rows[0].map((h) => String(h || "").toLowerCase().trim());

    let idCol = headers.indexOf(SUBMISSION_ID_HEADER);
    if (idCol === -1) {
      idCol = headers.findIndex((h) => h.includes(SUBMISSION_ID_HEADER));
    }
    const confessionCol = headers.findIndex((h) => h.includes(CONFESSION_HEADER));
    const mediaCol = headers.findIndex((h) => h.includes(MEDIA_HEADER));

    if (idCol === -1) {
      return jsonResponse({
        ok: false,
        error: 'Column "Submission ID" not found in Google Sheet.'
      });
    }

    // Search bottom-to-top so recent submissions resolve fastest
    for (let r = rows.length - 1; r >= 1; r--) {
      const rowId = String(rows[r][idCol] || "").trim();
      if (rowId.toLowerCase() === targetId.toLowerCase()) {
        const confession =
          confessionCol !== -1 ? String(rows[r][confessionCol] || "").trim() : "";
        const rawMedia =
          mediaCol !== -1 ? String(rows[r][mediaCol] || "").trim() : "";

        const urls = rawMedia
          ? rawMedia
              .split(/[\n,]+/)
              .map((u) => u.trim())
              .filter((u) => u.startsWith("http"))
          : [];

        return jsonResponse({
          ok: true,
          id: rowId,
          confession: confession,
          urls: urls
        });
      }
    }

    return jsonResponse({
      ok: false,
      error: `Submission ID "${targetId}" not found in Google Sheets.`
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: "Apps Script error: " + err.message
    });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}