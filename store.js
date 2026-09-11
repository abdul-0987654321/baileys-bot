'use strict';
/**
 * store.js — Australia Clinic data layer v6.1 (FIXED)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sheets = require('./sheets');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const PATHS = {
  root: DATA_DIR,
  auth: path.join(DATA_DIR, 'auth_session'),
  patients: path.join(DATA_DIR, 'patients'),
  settings: path.join(DATA_DIR, 'settings.json'),
  stats: path.join(DATA_DIR, 'stats.json'),
  conversations: path.join(DATA_DIR, 'conversations.json'),
};

for (const dir of [PATHS.root, PATHS.auth, PATHS.patients]) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] could not read ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function todayKey(d = new Date()) {
  const tz = getSettings().clinic.timezone;
  try {
    return new Date(d.toLocaleString('en-US', { timeZone: tz })).toISOString().slice(0, 10);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const DEFAULT_SETTINGS = {
  business: {
    name: 'Wellness Clinic',
    tagline: 'Your health, our priority',
    currencySymbol: '$',
    numberLocale: 'en-AU',
  },
  clinic: {
    phone: '61412345678',
    hours_open: '09:00',
    hours_close: '17:30',
    timezone: 'Australia/Sydney',
    open_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    emergency_contact: 'Call 000 for life-threatening emergencies',
    google_review_link: 'https://g.co/kgs/YOUR_CLINIC_ID',
    location: '123 Main Street, Sydney NSW 2000',
    appointment_length_min: 30,
    practitioners: ['Dr. Sarah Mitchell', 'Dr. James Wong', 'Any available'],
    slots: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30', '16:00'],
    booking_days_ahead: 3,
    services: [
      { id: 'checkup', label: 'Dental Checkup', price: 89 },
      { id: 'whitening', label: 'Teeth Whitening', price: 199 },
      { id: 'cleaning', label: 'Cleaning', price: 120 },
      { id: 'emergency', label: 'Emergency', price: null },
      { id: 'other', label: 'Other', price: null },
    ],
  },
  admin: {
    number: '',
    notifyNewAppointment: true,
    notifyAppointmentConfirmation: true,
    notifyCancellation: true,
    notifyQuestion: true,
    notifyTalkToStaff: true,
  },
  behavior: {
    sendReadReceipts: true,
    replyToGroups: false,
    autoReplyEnabled: true,
    showButtons: true,
  },
  delays: {
    min_ms: 3000,
    max_ms: 7000,
    typing_min_ms: 700,
    typing_max_ms: 1800,
  },
  automation: {
    appointment_confirmation: true,
    reminder_24h: true,
    reminder_2h: true,
    after_hours_responder: true,
    google_review: true,
    review_delay_hours: 2,
  },
  texts: {
    welcome: `🏥 *Welcome to {{clinic_name}}!*\n\nTap an option below, or type *menu* anytime.`,
    consent_request: `Before we begin, do we have your consent to send appointment updates and reminders on WhatsApp?\n\nTap *YES* to agree, or *NO* to decline.`,
    main_menu: `👋 *{{clinic_name}}* — how can we help?\n\nWhat would you like help with today?`,
    select_service: `Great! 😊 What type of appointment would you like to book?`,
    ask_name: `Perfect. Before I check the available appointments, may I get your name?`,
    ask_phone: `Thanks, {{name}}! What is the best phone number to reach you on?`,
    confirm_phone: `I have your WhatsApp number as your contact number. Is that okay?`,
    booking_summary: `Perfect! I have your appointment for:\n\n🩺 *Service:* {{service}}\n📅 *Date:* {{day}}\n🕐 *Time:* {{time}}\n👤 *Name:* {{name}}\n\nWould you like me to confirm this appointment?`,
    booking_cancelled_predraft: `No problem — I've cancelled that draft. Tap below whenever you'd like to start again.`,
    pricing_intro: `Here are our starting prices:\n\n{{price_list}}\n\nThe exact price can depend on the treatment recommended by the dentist.\n\nWould you like me to check available appointments?`,
    lead_followup_hours: `{{greeting}} {{name}} 👋 Just checking in. Would you still like help booking your appointment?`,
    lead_followup_nextday: `{{greeting}} {{name}}, we still have appointments available this week if you'd like to book one. 😊`,
    appointment_date: `📅 *Book an Appointment*\n\nWhich day works for you?`,
    appointment_time: `🕐 *Choose a time for {{day}}*\n\nTap an available slot below.`,
    appointment_practitioner: `🩺 *Any preferred practitioner?*\n\nOr tap "Any available".`,
    appointment_confirmed: `You're all set! ✅\n\nYour *{{service}}* appointment is confirmed for *{{appointment_time}}*.\n📍 *Where:* {{location}}\n\nWe'll send you a reminder before your appointment. If you need anything before then, just message us here. 😊\n\nReply *STOP* anytime to opt out of reminders.`,
    appointment_cancelled: `Your appointment on {{appointment_time}} has been cancelled.\n\nNeed to rebook? Tap *Book Appointment* below.`,
    reminder_24h: `{{greeting}} {{name}},\n\nA gentle reminder — your appointment is tomorrow at *{{appointment_time}}* at *{{clinic_name}}*.\n\nTap *Confirm* if all good, or *Reschedule* if something changed.`,
    reminder_2h: `{{greeting}} {{name}}, see you in ~2 hours at *{{appointment_time}}*. 📍 {{location}}`,
    after_hours: `Hi there! 👋\n\nOur clinic is currently *closed*.\n🕐 Hours: {{hours_open}}–{{hours_close}} ({{open_days}})\n📍 {{location}}\n\n🚨 {{emergency_contact}}\n\nTap below to book — we'll confirm next business day.\nReply *STOP* to opt out.`,
    reschedule_prompt: `Sure — let's reschedule. Tap the new day and time you'd prefer.`,
    question_prompt: `Please type your question and a member of our clinical team will reply shortly.`,
    staff_prompt: `We've let our front desk know — a team member will take over this chat shortly. 👍`,
    review_request: `{{greeting}} {{name}},\n\nThank you for visiting {{clinic_name}}! We hope you had a great experience. 🌟\n\nIf you have 30 seconds, a Google review really helps us:\n👉 {{review_link}}\n\nReply *STOP* to opt out.`,
    opted_out: `Understood — you've been removed from automated reminders.\n\nYou can still message us anytime. Reply *YES* to opt back in.`,
    fallback: `Sorry, I didn't quite catch that. Tap *Menu* below, or type "menu" to start again.`,
  },
};

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = Array.isArray(base) ? [] : { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && prev && typeof prev === 'object'
        ? deepMerge(prev, value)
        : value;
  }
  return out;
}

let settingsCache = null;

function getSettings() {
  if (!settingsCache) {
    const saved = readJson(PATHS.settings, {});
    settingsCache = deepMerge(DEFAULT_SETTINGS, saved);
    // FIX: purana Al-Noor naam auto-correct
    if (settingsCache.business.name && settingsCache.business.name.includes('Al-Noor')) {
      settingsCache.business.name = DEFAULT_SETTINGS.business.name;
      writeJson(PATHS.settings, settingsCache);
    }
    if (!fs.existsSync(PATHS.settings)) writeJson(PATHS.settings, settingsCache);
  }
  return settingsCache;
}

function saveSettings(patch) {
  settingsCache = deepMerge(getSettings(), patch || {});
  writeJson(PATHS.settings, settingsCache);
  sheets.syncSettings(settingsCache);
  return settingsCache;
}

function resetTexts() {
  settingsCache = getSettings();
  settingsCache.texts = { ...DEFAULT_SETTINGS.texts };
  writeJson(PATHS.settings, settingsCache);
  sheets.syncSettings(settingsCache);
  return settingsCache;
}

function renderText(key, vars = {}) {
  const settings = getSettings();
  const template = settings.texts[key] != null ? settings.texts[key] : DEFAULT_SETTINGS.texts[key];
  if (template == null) return '';
  const all = {
    clinic_name: settings.business.name,
    hours_open: settings.clinic.hours_open,
    hours_close: settings.clinic.hours_close,
    open_days: (settings.clinic.open_days || []).join(', '),
    emergency_contact: settings.clinic.emergency_contact,
    location: settings.clinic.location,
    review_link: settings.clinic.google_review_link,
    ...vars,
  };
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, name) =>
    all[name] == null ? '' : String(all[name])
  );
}

function patientFile(jid) {
  return path.join(PATHS.patients, `${String(jid).replace(/[^a-zA-Z0-9]/g, '_')}.json`);
}

function emptyPatient(jid) {
  return {
    jid,
    name: null,
    phone: null,
    opted_in: true,
    consent_timestamp: null,
    total_messages: 0,
    appointments: [],
    notes: '',
    first_seen: new Date().toISOString(),
    last_interaction: null,
    interactions: [],
    pricing_viewed_at: null,
    lead_followup_1_sent: false,
    lead_followup_2_sent: false,
  };
}

function getPatient(jid) {
  const existing = readJson(patientFile(jid), null);
  if (existing) {
    const base = emptyPatient(jid);
    return { ...base, ...existing, appointments: existing.appointments || [] };
  }
  return emptyPatient(jid);
}

function savePatient(record) {
  writeJson(patientFile(record.jid), record);
  sheets.syncPatient(record);
  return record;
}

function touchPatient(jid, { pushName, senderPn } = {}) {
  const record = getPatient(jid);
  const now = new Date().toISOString();
  if (!record.first_seen) record.first_seen = now;
  record.last_interaction = now;
  record.total_messages = (record.total_messages || 0) + 1;
  if (pushName && !record.name) record.name = pushName;
  if (senderPn && !record.phone) record.phone = String(senderPn).split('@')[0];
  return savePatient(record);
}

function listPatients() {
  if (!fs.existsSync(PATHS.patients)) return [];
  return fs
    .readdirSync(PATHS.patients)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(PATHS.patients, f), null))
    .filter(Boolean)
    .sort((a, b) => String(b.last_interaction || '').localeCompare(String(a.last_interaction || '')));
}

function deletePatient(jid) {
  const file = patientFile(jid);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  sheets.deletePatient(jid);
  return true;
}

function isSlotTaken(dateStr, timeStr, excludePatientJid = null) {
  for (const p of listPatients()) {
    if (excludePatientJid && p.jid === excludePatientJid) continue;
    for (const a of p.appointments || []) {
      if (a.date === dateStr && a.time === timeStr && !a.cancelled && !a.completed) return true;
    }
  }
  return false;
}

function availableSlots(dateStr) {
  const { slots } = getSettings().clinic;
  const today = todayKey();
  let cutoff = null;
  if (dateStr === today) {
    try {
      const tz = getSettings().clinic.timezone;
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
      const hh = parseInt(parts.find((p) => p.type === 'hour').value, 10);
      const mm = parseInt(parts.find((p) => p.type === 'minute').value, 10);
      cutoff = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    } catch { cutoff = null; }
  }
  return slots.filter((t) => {
    if (cutoff && t <= cutoff) return false;
    return !isSlotTaken(dateStr, t);
  });
}

function upcomingDays(n = 3) {
  const settings = getSettings();
  const days = [];
  const openSet = new Set((settings.clinic.open_days || []).map((d) => d.toLowerCase()));
  for (let i = 0; i < n * 2 && days.length < n; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const inTz = new Date(d.toLocaleString('en-US', { timeZone: settings.clinic.timezone }));
    const dow = inTz.toLocaleDateString('en-AU', { weekday: 'short' });
    if (openSet.size && !openSet.has(dow.toLowerCase())) continue;
    const key = inTz.toISOString().slice(0, 10);
    if (!days.includes(key)) days.push(key);
  }
  return days;
}

// FIX: customer-facing day-picker me sirf wahi din dikhao jinme actually koi slot bacha ho —
// warna "Today" jaisa din bhi dikhta tha jab uske saare slots ya to book ho chuke hote ya
// cutoff time nikal chuka hota, aur user select karne pe "fully booked" milta.
// n*3 candidates check karte hain taake har case me n available din mil jayein.
function upcomingDaysWithAvailability(n = 3) {
  const settings = getSettings();
  const openSet = new Set((settings.clinic.open_days || []).map((d) => d.toLowerCase()));
  const out = [];
  for (let i = 0; i < n * 6 && out.length < n; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const inTz = new Date(d.toLocaleString('en-US', { timeZone: settings.clinic.timezone }));
    const dow = inTz.toLocaleDateString('en-AU', { weekday: 'short' });
    if (openSet.size && !openSet.has(dow.toLowerCase())) continue;
    const key = inTz.toISOString().slice(0, 10);
    if (out.includes(key)) continue;
    if (availableSlots(key).length > 0) out.push(key);
  }
  return out;
}

function dayLabel(dateStr) {
  const today = todayKey();
  const tmrwDate = new Date(`${today}T12:00:00`);
  tmrwDate.setDate(tmrwDate.getDate() + 1);
  const tmrw = tmrwDate.toISOString().slice(0, 10);
  if (dateStr === today) return 'Today';
  if (dateStr === tmrw) return 'Tomorrow';
  try {
    return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-AU', {
      weekday: 'short', day: 'numeric', month: 'short',
    });
  } catch {
    return dateStr;
  }
}

function formatAppointmentTime(date, time) {
  try {
    const d = new Date(`${date}T${time}`);
    return d.toLocaleString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return `${date} at ${time}`;
  }
}

function bookSlot({ jid, date, time, type = 'consultation', practitioner = 'Any available', notes = '' }) {
  const patient = getPatient(jid);
  const appointment = {
    id: newId('apt'),
    date,
    time,
    type,
    practitioner,
    status: 'confirmed',
    confirmed: true,
    cancelled: false,
    completed: false,
    reminder_sent: false,
    reminder_2h_sent: false,
    review_sent: false,
    notes,
    created_at: new Date().toISOString(),
  };
  patient.appointments = patient.appointments || [];
  patient.appointments.push(appointment);
  savePatient(patient);
  bumpStat('appointmentsBooked');
  return { patient, appointment };
}

function findAppointment(jid, { id, date, time } = {}) {
  const patient = getPatient(jid);
  const list = patient.appointments || [];
  if (id) return list.find((a) => a.id === id) || null;
  const upcoming = list
    .filter((a) => !a.cancelled && !a.completed)
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  if (date && time) return upcoming.find((a) => a.date === date && a.time === time) || null;
  return upcoming[0] || null;
}

function updateAppointment(jid, appointmentId, patch) {
  const patient = getPatient(jid);
  const a = (patient.appointments || []).find((x) => x.id === appointmentId);
  if (!a) return null;
  Object.assign(a, patch);
  savePatient(patient);
  sheets.syncAppointment({ ...a, patient_jid: jid, patient_name: patient.name, patient_phone: patient.phone });
  return a;
}

function cancelAppointment(jid, appointmentId) {
  const a = updateAppointment(jid, appointmentId, {
    cancelled: true, confirmed: false, status: 'cancelled',
  });
  if (a) bumpStat('appointmentsCancelled');
  return a;
}

function completeAppointment(jid, appointmentId) {
  return updateAppointment(jid, appointmentId, { completed: true, status: 'completed' });
}

function listAllAppointments() {
  const out = [];
  for (const p of listPatients()) {
    for (const a of p.appointments || []) {
      out.push({ ...a, patient_jid: p.jid, patient_name: p.name, patient_phone: p.phone });
    }
  }
  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

function appointmentsOnDate(dateStr) {
  return listAllAppointments().filter((a) => a.date === dateStr && !a.cancelled);
}

function adminJid() {
  const num = String(getSettings().admin.number || '').replace(/\D/g, '');
  return num ? `${num}@s.whatsapp.net` : null;
}

function shouldNotifyAdmin(flag) {
  return Boolean(adminJid()) && getSettings().admin[flag] !== false;
}

const EMPTY_STATS = {
  messagesIn: 0,
  messagesOut: 0,
  appointmentsBooked: 0,
  appointmentsCancelled: 0,
  remindersQueued: 0,
  reviewsRequested: 0,
  byDay: {},
  firstBootAt: null,
};

let statsCache = null;
let statsDirty = false;
let statsFlushTimer = null;

function getStats() {
  if (!statsCache) {
    statsCache = { ...EMPTY_STATS, ...readJson(PATHS.stats, {}) };
    if (!statsCache.byDay) statsCache.byDay = {};
    if (!statsCache.firstBootAt) {
      statsCache.firstBootAt = new Date().toISOString();
      statsDirty = true;
    }
  }
  return statsCache;
}

function bumpStat(key, amount = 1) {
  const stats = getStats();
  stats[key] = (stats[key] || 0) + amount;
  const day = todayKey();
  if (!stats.byDay[day]) stats.byDay[day] = { in: 0, out: 0, appointments: 0 };
  if (key === 'messagesIn') stats.byDay[day].in += amount;
  if (key === 'messagesOut') stats.byDay[day].out += amount;
  if (key === 'appointmentsBooked') stats.byDay[day].appointments += amount;
  statsDirty = true;
  scheduleStatsFlush();
  return stats;
}

function scheduleStatsFlush() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => {
    statsFlushTimer = null;
    flushStats();
  }, 2000);
  statsFlushTimer.unref?.();
}

function flushStats() {
  if (statsFlushTimer) {
    clearTimeout(statsFlushTimer);
    statsFlushTimer = null;
  }
  if (!statsDirty || !statsCache) return;
  writeJson(PATHS.stats, statsCache);
  sheets.syncStats(statsCache);
  statsDirty = false;
}

function lastNDays(n = 14) {
  const stats = getStats();
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    out.push({ day: key, ...(stats.byDay[key] || { in: 0, out: 0, appointments: 0 }) });
  }
  return out;
}

function logChatEvent({ direction, jid, name, text }) {
  sheets.logMessage({ direction, jid, name, text });
}

async function restoreFromSheet() {
  if (!sheets.SYNC_ENABLED) return { ok: false, message: 'Sheet sync disabled.' };
  const pulled = await sheets.pullAll();
  let restored = 0;
  for (const p of pulled.patients || []) {
    if (!p.jid) continue;
    writeJson(patientFile(p.jid), { ...emptyPatient(p.jid), ...p });
    restored += 1;
  }
  if (pulled.settings && typeof pulled.settings === 'object') {
    settingsCache = deepMerge(DEFAULT_SETTINGS, pulled.settings);
    writeJson(PATHS.settings, settingsCache);
  }
  if (pulled.stats && typeof pulled.stats === 'object') {
    statsCache = { ...EMPTY_STATS, ...pulled.stats };
    writeJson(PATHS.stats, statsCache);
  }
  return { ok: true, message: `Restored ${restored} patient(s) + settings from Google Sheet.`, restored };
}

async function autoRestoreIfEmpty() {
  if (!sheets.SYNC_ENABLED) return;
  try {
    const localPatients = listPatients();
    const localSettings = fs.existsSync(PATHS.settings);
    if (localPatients.length === 0 && !localSettings) {
      const result = await restoreFromSheet();
      if (result.ok) console.log(`[store] ${result.message}`);
    }
  } catch (err) {
    console.error(`[store] auto-restore failed: ${err.message}`);
  }
}

function loadConversations() {
  return readJson(PATHS.conversations, { chats: {}, processedIds: [] });
}

function saveConversations(data) {
  writeJson(PATHS.conversations, data);
}

function backupSession() {
  const files = {};
  if (fs.existsSync(PATHS.auth)) {
    for (const name of fs.readdirSync(PATHS.auth)) {
      const full = path.join(PATHS.auth, name);
      if (fs.statSync(full).isFile()) files[name] = fs.readFileSync(full, 'base64');
    }
  }
  return { createdAt: new Date().toISOString(), fileCount: Object.keys(files).length, files };
}

function restoreSession(backup) {
  if (!backup || typeof backup.files !== 'object') throw new Error('Backup file has no "files" section.');
  fs.mkdirSync(PATHS.auth, { recursive: true });
  for (const name of fs.readdirSync(PATHS.auth)) {
    const full = path.join(PATHS.auth, name);
    if (fs.statSync(full).isFile()) fs.unlinkSync(full);
  }
  let written = 0;
  for (const [name, b64] of Object.entries(backup.files)) {
    const safe = path.basename(name);
    fs.writeFileSync(path.join(PATHS.auth, safe), Buffer.from(b64, 'base64'));
    written += 1;
  }
  return written;
}

function clearSession() {
  if (!fs.existsSync(PATHS.auth)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(PATHS.auth)) {
    const full = path.join(PATHS.auth, name);
    if (fs.statSync(full).isFile()) {
      fs.unlinkSync(full);
      removed += 1;
    }
  }
  return removed;
}

setInterval(flushStats, 10000).unref();
process.on('exit', flushStats);

module.exports = {
  PATHS,
  DATA_DIR,
  DEFAULT_SETTINGS,
  sheets,
  getSettings,
  saveSettings,
  resetTexts,
  renderText,
  getPatient,
  savePatient,
  touchPatient,
  listPatients,
  deletePatient,
  isSlotTaken,
  availableSlots,
  upcomingDays,
  upcomingDaysWithAvailability,
  dayLabel,
  formatAppointmentTime,
  bookSlot,
  findAppointment,
  updateAppointment,
  cancelAppointment,
  completeAppointment,
  listAllAppointments,
  appointmentsOnDate,
  adminJid,
  shouldNotifyAdmin,
  getStats,
  bumpStat,
  flushStats,
  lastNDays,
  logChatEvent,
  restoreFromSheet,
  autoRestoreIfEmpty,
  loadConversations,
  saveConversations,
  backupSession,
  restoreSession,
  clearSession,
  newId,
};
