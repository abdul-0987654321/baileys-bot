'use strict';
/**
 * sheets.js — Google Sheets sync layer (via Apps Script Web App / code.gs)
 * Australia Clinic edition — v6
 *
 * Sab data (patients, appointments, settings, stats, messages) Google Sheet me
 * save hota hai. Local JSON files sirf fast cache hain; sheet = permanent DB.
 *
 * Env:
 *   SHEET_WEBAPP_URL   — code.gs ka deployed /exec URL (default: Abdul ka script)
 *   SHEET_SYNC_ENABLED — 'true'/'false' (default: true agar URL set hai)
 *
 * code.gs 302 redirect karta hai, is liye fetch redirect:'follow' use hota hai.
 * Content-Type text/plain rakha hai taake CORS preflight na ho.
 */

// FIX: pehle yahan ek DEFAULT_WEBAPP_URL hardcoded thi (kisi aur ki deployed script).
// Agar tum apna SHEET_WEBAPP_URL .env me set karna bhool jate, to tumhara patient data
// chup chaap USI purani script/sheet me chala jata — tumhari apni sheet khaali rehti
// aur lagta "kuch kaam hi nahi kar raha". Ab agar URL set nahi hai, sync khud OFF ho
// jayega (silent leak ki jagah clear warning).
const RAW_URL = String(process.env.SHEET_WEBAPP_URL || '').trim();
const isPlaceholder = !RAW_URL || RAW_URL.includes('XXXXXXXX') || RAW_URL === 'https://script.google.com/macros/s//exec';
const WEBAPP_URL = isPlaceholder ? '' : RAW_URL;
const SYNC_ENABLED =
  String(process.env.SHEET_SYNC_ENABLED || 'true').toLowerCase() !== 'false' && Boolean(WEBAPP_URL);

if (isPlaceholder) {
  console.warn(
    '\n[sheets] SHEET_WEBAPP_URL is not set (or still the XXXXXXXX placeholder) — Google Sheet sync is OFF.\n' +
    '[sheets] Deploy your own code.gs as a Web App, copy its /exec URL, and put it in your .env / Render env vars as SHEET_WEBAPP_URL.\n'
  );
}

const state = {
  enabled: SYNC_ENABLED,
  url: WEBAPP_URL,
  queued: 0,
  lastSyncAt: null,
  lastError: null,
  consecutiveFailures: 0,
  totalPushed: 0,
};

const queue = [];
let workerRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Raw call to Apps Script (timeout + JSON parse) ---------- */

async function callScript(action, data = {}, timeoutMs = 35000) { // FIX: Apps Script lock 30s tak wait karta hai, Node timeout usse zyada rakha
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, data }),
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`Sheet script returned non-JSON (status ${res.status}): ${text.slice(0, 160)}`);
    }
    if (!json.ok) throw new Error(json.message || `Sheet action "${action}" failed`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Fire-and-forget queued sync with retries ---------- */

function enqueue(job) {
  if (!SYNC_ENABLED) return;
  queue.push({ ...job, attempt: 0 });
  state.queued = queue.length;
  void runWorker();
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      state.queued = queue.length;
      try {
        await callScript(job.action, job.data);
        state.lastSyncAt = new Date().toISOString();
        state.lastError = null;
        state.consecutiveFailures = 0;
        state.totalPushed += 1;
        if (typeof job.onOk === 'function') job.onOk();
      } catch (err) {
        job.attempt += 1;
        // FIX: err.message akela generic "fetch failed" deta hai — asli wajah (DNS/network
        // error code) err.cause me chhupi hoti hai. Ab wo bhi dashboard pe dikhegi.
        const causeInfo = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
        state.lastError = `${job.action}: ${err.message}${causeInfo}`;
        state.consecutiveFailures += 1;
        if (job.attempt < 4) {
          queue.push(job); // dobara try (backoff neeche)
          state.queued = queue.length;
          await sleep(2000 * job.attempt * job.attempt); // ~2s, 8s, 18s
        } else {
          console.error(`[sheets] giving up on ${job.action}: ${err.message}`);
          if (typeof job.onFail === 'function') job.onFail(err);
        }
      }
      await sleep(300); // Apps Script quota ko saans lene do
    }
  } finally {
    workerRunning = false;
    state.queued = queue.length;
  }
}

/* ---------- Public sync helpers (store.js / bot.js inko call karte hain) ---------- */

function syncPatient(patient) {
  enqueue({ action: 'upsert_patient', data: patient });
}

function deletePatient(jid) {
  enqueue({ action: 'delete_patient', data: { jid } });
}

function syncAppointment(appointment) {
  enqueue({ action: 'upsert_appointment', data: appointment });
}

function deleteAppointment(id) {
  enqueue({ action: 'delete_appointment', data: { id } });
}

function syncSettings(settings) {
  enqueue({ action: 'save_settings', data: { settings } });
}

function syncStats(stats) {
  enqueue({ action: 'save_stats', data: { stats } });
}

function logEvent(type, message) {
  enqueue({ action: 'log_event', data: { type, message } });
}

/** Chat message row — Messages tab + Log tab dono me jata hai (code.gs me handle). */
function logMessage({ direction, jid, name, text, timestamp }) {
  enqueue({
    action: 'log_message',
    data: {
      direction: direction || 'out',
      jid: jid || '',
      name: name || '',
      text: String(text || '').slice(0, 2000),
      timestamp: timestamp || new Date().toISOString(),
    },
  });
}

/** store.js isko optional call karta hai — alias rakha taake crash na ho. */
const enqueueMessage = logMessage;

/* ---------- Immediate (awaited) calls — restore / force-sync ke liye ---------- */

async function pullAll() {
  const res = await callScript('pull_all', {}, 40000);
  return res.data || {}; // { patients, appointments, settings, stats }
}

async function ping() {
  const res = await callScript('ping', {});
  return res.message || 'pong';
}

/** Sab local data sheet pe force push (dashboard ka "Sync to Sheet" button). */
async function pushAll(listPatients, getSettings, getStats) {
  if (!SYNC_ENABLED) return { ok: false, message: 'Sheet sync disabled.' };
  const settings = typeof getSettings === 'function' ? getSettings() : null;
  const stats = typeof getStats === 'function' ? getStats() : null;
  const patients = typeof listPatients === 'function' ? listPatients() : [];
  const res = await callScript('push_all', { patients, settings, stats }, 60000);
  state.lastSyncAt = new Date().toISOString();
  return { ok: true, message: res.message || `Pushed ${patients.length} patient(s) + settings to Google Sheet.` };
}

function getStatus() {
  return { ...state };
}

/** Shutdown ke waqt queue khatam hone ka chance do. */
function flushTimeout(maxWaitMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (queue.length === 0 || Date.now() - started > maxWaitMs) {
        clearInterval(t);
        resolve(queue.length);
      }
    }, 250);
    t.unref?.();
  });
}

module.exports = {
  getStatus,
  ping,
  pullAll,
  pushAll,
  syncPatient,
  syncAppointment,
  deleteAppointment,
  syncSettings,
  syncStats,
  deletePatient,
  logEvent,
  logMessage,
  enqueueMessage,
  flushTimeout,
  SYNC_ENABLED,
  WEBAPP_URL,
};
