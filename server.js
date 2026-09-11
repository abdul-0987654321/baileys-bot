'use strict';
/**
 * server.js — One process: Clinic dashboard + REST API + WhatsApp bot.
 * Australia Clinic edition — v6
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

/* ---------- tiny .env loader (no dependency needed) ---------- */
function loadEnvFile() {
  try {
    const envPath = process.env.ENV_FILE || path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      if (quoted && value.length > 1) value = value.slice(1, -1);
      if (value !== '' && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    console.error(`[env] could not read .env: ${err.message}`);
  }
}
loadEnvFile();

const store = require('./store');
const bot = require('./bot');

const PORT = process.env.PORT || 3000;
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.set('trust proxy', true); // Render ke peeche real IP ke liye

/* ================================================================== *
 * auth — signed cookie, no database needed
 * ================================================================== */

let PASSWORD = process.env.DASHBOARD_PASSWORD;
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(4).toString('hex');
  console.log('\n' + '='.repeat(64));
  console.log('  DASHBOARD_PASSWORD not set — generated a temporary one:');
  console.log(`      ${PASSWORD}`);
  console.log('  Set DASHBOARD_PASSWORD in your environment to keep it stable.');
  console.log('='.repeat(64) + '\n');
}

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'clinic_session';
const SESSION_DAYS = 7;

function signToken() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now();
  } catch { return false; }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

const loginAttempts = new Map(); // ip -> { count, until }

function loginBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.until && entry.until > Date.now()) return true;
  if (entry.until && entry.until <= Date.now()) loginAttempts.delete(ip);
  return false;
}

function noteFailedLogin(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= 6) { entry.until = Date.now() + 5 * 60000; entry.count = 0; }
  loginAttempts.set(ip, entry);
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) return res.status(429).json({ ok: false, message: 'Too many attempts. Try again in 5 minutes.' });
  const supplied = String(req.body?.password || '');
  const ok = supplied.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(PASSWORD));
  if (!ok) { noteFailedLogin(ip); return res.status(401).json({ ok: false, message: 'Wrong password.' }); }
  loginAttempts.delete(ip);
  res.setHeader('Set-Cookie', `${COOKIE}=${signToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, bot: bot.getStatus().status, clinicOpen: bot.isClinicOpen(), uptimeSeconds: Math.round(process.uptime()) });
});

// Baaki sab /api endpoints ko valid cookie chahiye.
app.use('/api', (req, res, next) => {
  if (verifyToken(parseCookies(req)[COOKIE])) return next();
  return res.status(401).json({ ok: false, message: 'Not signed in.' });
});

app.get('/api/session', (req, res) => res.json({ ok: true }));

/* ================================================================== *
 * overview
 * ================================================================== */

app.get('/api/overview', (req, res) => {
  const patients = store.listPatients();
  const stats = store.getStats();
  const appointments = store.listAllAppointments();

  const upcoming = appointments.filter((a) => !a.cancelled && !a.completed);
  const todayKey = new Date(new Date().toLocaleString('en-US', { timeZone: store.getSettings().clinic.timezone })).toISOString().slice(0, 10);
  const todayCount = upcoming.filter((a) => a.date === todayKey).length;

  res.json({
    ok: true,
    bot: bot.getStatus(),
    clinicOpen: bot.isClinicOpen(),
    stats: {
      patients: patients.length,
      totalAppointments: appointments.length,
      upcomingAppointments: upcoming.length,
      todayAppointments: todayCount,
      confirmedAppointments: appointments.filter((a) => a.confirmed || a.status === 'confirmed').length,
      messagesIn: stats.messagesIn || 0,
      messagesOut: stats.messagesOut || 0,
      appointmentsBooked: stats.appointmentsBooked || 0,
      remindersQueued: stats.remindersQueued || 0,
      reviewsRequested: stats.reviewsRequested || 0,
    },
    trend: store.lastNDays(14),
    recent: patients.slice(0, 12),
    nextAppointments: upcoming.slice(0, 8),
    sheet: store.sheets.getStatus(),
    dataDir: store.DATA_DIR,
    serverUptimeSeconds: Math.round(process.uptime()),
  });
});

/* ================================================================== *
 * patients / leads
 * ================================================================== */

app.get('/api/patients', (req, res) => res.json({ ok: true, patients: store.listPatients() }));

app.get('/api/patients/:jid', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  res.json({ ok: true, patient: store.getPatient(jid) });
});

app.put('/api/patients/:jid', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const patient = store.getPatient(jid);
  if (req.body.opted_in !== undefined) patient.opted_in = Boolean(req.body.opted_in);
  if (req.body.name !== undefined) patient.name = String(req.body.name);
  if (req.body.notes !== undefined) patient.notes = String(req.body.notes);
  store.savePatient(patient);
  res.json({ ok: true, patient });
});

app.delete('/api/patients/:jid', (req, res) => {
  const removed = store.deletePatient(decodeURIComponent(req.params.jid));
  if (!removed) return res.status(404).json({ ok: false, message: 'Patient not found.' });
  res.json({ ok: true });
});

/* ================================================================== *
 * appointments
 * ================================================================== */

app.get('/api/appointments', (req, res) => {
  const all = store.listAllAppointments();
  const view = req.query.view; // upcoming | past | all
  let list = all;
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: store.getSettings().clinic.timezone })).toISOString().slice(0, 10);
  if (view === 'upcoming') list = all.filter((a) => !a.cancelled && a.date >= today);
  if (view === 'past') list = all.filter((a) => a.date < today || a.completed || a.cancelled);
  res.json({ ok: true, appointments: list });
});

app.post('/api/appointments/:jid/:id/complete', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const a = store.completeAppointment(jid, req.params.id);
  // completed_at set karo (review cron isi pe chalta hai)
  if (a) store.updateAppointment(jid, req.params.id, { completed_at: new Date().toISOString() });
  res.json({ ok: Boolean(a), appointment: a });
});

app.post('/api/appointments/:jid/:id/cancel', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const a = store.cancelAppointment(jid, req.params.id);
  res.json({ ok: Boolean(a), appointment: a });
});

/** Naya appointment dashboard se manually book karo. */
app.post('/api/appointments', (req, res) => {
  const { jid, phone, date, time, type, practitioner, name } = req.body || {};
  const targetJid = jid || (phone ? `${String(phone).replace(/\D/g, '')}@s.whatsapp.net` : null);
  if (!targetJid) return res.status(400).json({ ok: false, message: 'Provide jid or phone.' });
  if (!date || !time) return res.status(400).json({ ok: false, message: 'date and time are required.' });
  if (store.isSlotTaken(date, time, targetJid)) return res.status(409).json({ ok: false, message: 'That slot is already booked.' });
  const patient = store.getPatient(targetJid);
  if (name && !patient.name) { patient.name = name; store.savePatient(patient); }
  const result = store.bookSlot({ jid: targetJid, date, time, type: type || 'consultation', practitioner: practitioner || 'Any available' });
  res.json({ ok: true, appointment: result.appointment });
});

/** Kisi din ke available slots (booking form ke liye). */
app.get('/api/slots', (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ ok: false, message: 'date (YYYY-MM-DD) required.' });
  res.json({ ok: true, date, slots: store.availableSlots(date), label: store.dayLabel(date) });
});

app.get('/api/days', (req, res) => {
  const n = parseInt(req.query.days, 10) || store.getSettings().clinic.booking_days_ahead;
  const days = store.upcomingDays(n).map((d) => ({ date: d, label: store.dayLabel(d) }));
  res.json({ ok: true, days });
});

/* ================================================================== *
 * settings
 * ================================================================== */

app.get('/api/settings', (req, res) =>
  res.json({ ok: true, settings: store.getSettings(), defaults: store.DEFAULT_SETTINGS })
);

app.put('/api/settings', (req, res) => {
  const settings = store.saveSettings(req.body || {});
  res.json({ ok: true, settings });
});

app.post('/api/settings/reset-texts', (req, res) => {
  const settings = store.resetTexts();
  res.json({ ok: true, settings });
});

/* ================================================================== *
 * bot control
 * ================================================================== */

app.get('/api/bot/status', (req, res) => res.json({ ok: true, ...bot.getStatus() }));

app.post('/api/bot/start', async (req, res) => {
  const result = await bot.start();
  res.json({ ...result, status: bot.getStatus() });
});

app.post('/api/bot/stop', async (req, res) => {
  const result = await bot.stop();
  res.json({ ...result, status: bot.getStatus() });
});

app.post('/api/bot/logout', async (req, res) => {
  const result = await bot.logout();
  res.json({ ...result, status: bot.getStatus() });
});

app.get('/api/logs', (req, res) => {
  const limit = Math.min(400, Math.max(20, parseInt(req.query.limit, 10) || 200));
  res.json({ ok: true, logs: bot.getLogs(limit) });
});

app.post('/api/messages/send', async (req, res) => {
  const { to, text } = req.body || {};
  const result = await bot.sendManual(to, text);
  res.status(result.ok ? 200 : 400).json(result);
});

/* ================================================================== *
 * Google Sheet sync controls
 * ================================================================== */

app.get('/api/sheet/status', (req, res) => res.json({ ok: true, sheet: store.sheets.getStatus() }));

app.post('/api/sheet/ping', async (req, res) => {
  try {
    const msg = await store.sheets.ping();
    res.json({ ok: true, message: msg });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/** Sab local data sheet pe force push. */
app.post('/api/sheet/push', async (req, res) => {
  try {
    const result = await store.sheets.pushAll(store.listPatients, store.getSettings, store.getStats);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/** Sheet se saara data local me wapas laao (restore). */
app.post('/api/sheet/restore', async (req, res) => {
  try {
    const result = await store.restoreFromSheet();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/* ================================================================== *
 * session backup / restore (ephemeral disk workaround)
 * ================================================================== */

app.get('/api/session/backup', (req, res) => {
  const backup = store.backupSession();
  if (!backup.fileCount) return res.status(400).json({ ok: false, message: 'No session to back up yet. Connect and scan the QR first.' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="whatsapp-session-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(backup));
});

app.post('/api/session/restore', async (req, res) => {
  if (bot.isConnected()) return res.status(400).json({ ok: false, message: 'Stop the bot before restoring a session.' });
  try {
    const written = store.restoreSession(req.body);
    res.json({ ok: true, message: `Restored ${written} session file(s). Press Connect.` });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/* ================================================================== *
 * static dashboard
 * ================================================================== */

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
  })
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, message: 'Unknown endpoint.' });
  return res.status(404).send('Not found');
});

/* ================================================================== *
 * boot + cron triggers
 * ================================================================== */

const server = app.listen(PORT, async () => {
  const s = store.getSettings();
  console.log(`\n  ${s.business.name} — Clinic WhatsApp Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  data directory: ${store.DATA_DIR}`);
  console.log(`  sheet sync: ${store.sheets.SYNC_ENABLED ? 'ON' : 'OFF'}\n`);

  // Render ephemeral disk — sheet se data wapas laao agar local khali hai
  await store.autoRestoreIfEmpty().catch((e) => console.error('[boot] auto-restore:', e.message));

  if (String(process.env.AUTOSTART_BOT).toLowerCase() === 'true') {
    console.log('  AUTOSTART_BOT=true — connecting WhatsApp now');
    void bot.start();
  } else {
    console.log('  Open the dashboard and press Connect to bring WhatsApp online.\n');
  }
});

// 24h + 2h appointment reminders — har ghante
setInterval(async () => {
  try { await bot.sendAppointmentReminders(); }
  catch (err) { console.error('[cron] reminder job failed:', err.message); }
}, 3600000);

// Google review requests — har 30 minute
setInterval(async () => {
  try { await bot.sendReviewRequests(); }
  catch (err) { console.error('[cron] review job failed:', err.message); }
}, 1800000);

// Pricing dekha par book nahi kiya — lead follow-up (3hr + next-day) — har 30 minute
setInterval(async () => {
  try { await bot.sendLeadFollowups(); }
  catch (err) { console.error('[cron] lead follow-up job failed:', err.message); }
}, 1800000);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — saving state`);
  bot.shutdown();
  store.flushStats();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 6000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err?.message || err));
