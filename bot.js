'use strict';
/**
 * bot.js — Australia Clinic WhatsApp bot v6.2 FIXED
 * FIX: YES/NO buttons + after_hours consent ko block nahi karega + no loop
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@itsliaaa/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const store = require('./store');

const logger = pino({ level: 'silent' });

const runtime = {
  sock: null,
  status: 'stopped',
  qrDataUrl: null,
  qrGeneratedAt: null,
  me: null,
  connectedAt: null,
  lastError: null,
  reconnectAttempts: 0,
  manualStop: false,
  busy: false,
  queueDepth: 0,
};

const LOG_LIMIT = 400;
const logs = [];
function log(level, message) {
  const entry = { at: new Date().toISOString(), level, message };
  logs.push(entry);
  while (logs.length > LOG_LIMIT) logs.shift();
  const prefix = { info: '·', warn: '!', error: 'x', chat: '>' }[level] || '·';
  console.log(`${prefix} ${message}`);
  return entry;
}
function getLogs(limit = 200) { return logs.slice(-limit); }
function getStatus() {
  return {
    status: runtime.status,
    qrDataUrl: runtime.status === 'qr' ? runtime.qrDataUrl : null,
    qrGeneratedAt: runtime.qrGeneratedAt,
    me: runtime.me,
    connectedAt: runtime.connectedAt,
    lastError: runtime.lastError,
    reconnectAttempts: runtime.reconnectAttempts,
    queueDepth: runtime.queueDepth,
    sheet: store.sheets.getStatus(),
  };
}
function isConnected() { return runtime.status === 'connected' && Boolean(runtime.sock); }

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const getGreeting = () => ['Hi', 'Hello', 'Hey', 'Good day'][Math.floor(Math.random() * 4)];

function extractText(msg) {
  const m =
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message ||
    msg.message?.viewOnceMessageV2?.message ||
    msg.message?.documentWithCaptionMessage?.message ||
    msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
}
function jidFromNumber(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (text.includes('@')) return text;
  const digits = text.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}
function showButtons() { return store.getSettings().behavior.showButtons !== false; }

const chatLocks = new Map();
function withChatLock(jid, fn) {
  const previous = chatLocks.get(jid) || Promise.resolve();
  const next = previous.then(fn, fn).catch((err) => {
    log('error', `Handler crashed for ${jid}: ${err.message}`);
  });
  chatLocks.set(jid, next);
  next.finally(() => {
    if (chatLocks.get(jid) === next) chatLocks.delete(jid);
  });
  return next;
}

const sendQueue = [];
let workerRunning = false;
function enqueueSend(jid, content, options = {}) {
  return new Promise((resolve) => {
    sendQueue.push({ jid, content, options, resolve });
    runtime.queueDepth = sendQueue.length;
    void runWorker();
  });
}
async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (sendQueue.length) {
      const job = sendQueue.shift();
      runtime.queueDepth = sendQueue.length;
      if (!runtime.sock) { job.resolve({ ok: false, error: 'Socket disconnected' }); continue; }
      const { min_ms, max_ms, typing_min_ms, typing_max_ms } = store.getSettings().delays;
      await sleep(randomBetween(min_ms, max_ms));
      if (!job.options.skipTyping) {
        try {
          await runtime.sock.sendPresenceUpdate('composing', job.jid);
          await sleep(randomBetween(typing_min_ms, typing_max_ms));
          await runtime.sock.sendPresenceUpdate('paused', job.jid);
        } catch (_) {}
      }
      try {
        await runtime.sock.sendMessage(job.jid, job.content);
        if (!job.options.noCount) store.bumpStat('messagesOut');
        if (job.options.logOut) store.logChatEvent({ direction: 'out', jid: job.jid, name: '', text: job.content.text || job.content.caption || '[interactive]' });
        job.resolve({ ok: true });
      } catch (err) {
        log('error', `Send failed for ${job.jid}: ${err.message}`);
        job.resolve({ ok: false, error: err.message });
      }
    }
  } finally {
    workerRunning = false;
    runtime.queueDepth = sendQueue.length;
  }
}
async function sendWithDelay(jid, payload, options = {}) {
  const patient = store.getPatient(jid);
  if (!patient.opted_in && !options.allowOptedOut) {
    log('warn', `${jid} opted out — blocking automated send`);
    return { ok: false, error: 'opted_out' };
  }
  return enqueueSend(jid, payload, { logOut: true, ...options });
}

// ---- NATIVE BUILDERS ----
async function sendConsentRequest(jid) {
  // FIX: "welcome" template pehle kabhi bheja hi nahi jata tha — patient ko seedha
  // consent form mil jata tha, jo cold/unfriendly lagta hai. Ab dono ek sath jaate hain.
  const text = `${store.renderText('welcome')}\n\n${store.renderText('consent_request')}`;
  if (showButtons()) {
    await enqueueSend(jid, {
      text,
      footer: store.getSettings().business.name,
      nativeFlow: [
        { text: '✅ YES — I Consent', id: 'YES' },
        { text: '❌ NO', id: 'NO' },
      ],
    }, { skipTyping: true, allowOptedOut: true, logOut: true });
  } else {
    await enqueueSend(jid, { text }, { skipTyping: true, allowOptedOut: true, logOut: true });
  }
}
async function sendMainMenu(jid) {
  const text = store.renderText('main_menu');
  if (showButtons()) {
    await sendWithDelay(jid, {
      text,
      footer: store.getSettings().business.name,
      buttonText: '📋 More options',
      title: 'How can we help?',
      sections: [{
        title: 'Main menu',
        rows: [
          { title: '📅 Book an Appointment', description: 'Pick a service, day and time', rowId: 'book' },
          { title: '❓ Ask a Question', description: 'Talk to our clinical team', rowId: 'question' },
          { title: '💲 Pricing', description: 'See starting prices', rowId: 'pricing' },
          { title: '🙋 Talk to Staff', description: 'Get a human on the chat', rowId: 'staff' },
          { title: '🚫 Stop Messages', description: 'Opt out of automated texts', rowId: 'STOP' },
        ],
      }],
    });
  } else {
    await sendWithDelay(jid, { text: `${text}\n\nReply:\n1 — Book an Appointment\n2 — Ask a Question\n3 — Pricing\n4 — Talk to Staff\n5 — Stop Messages (or type STOP)` });
  }
}
async function sendServicePicker(jid) {
  const services = store.getSettings().clinic.services || [];
  const text = store.renderText('select_service');
  const rows = services.map((s) => ({ title: s.label, description: s.price ? `From ${store.getSettings().business.currencySymbol}${s.price}` : 'Ask for pricing', rowId: `svc:${s.id}` }));
  if (showButtons()) {
    await sendWithDelay(jid, {
      text, footer: store.getSettings().business.name,
      buttonText: '🩺 Choose a service', title: 'Select appointment type',
      sections: [{ title: 'Services', rows }],
    });
  } else {
    const list = services.map((s, i) => `${i + 1} — ${s.label}`).join('\n');
    await sendWithDelay(jid, { text: `${text}\n\n${list}\n\nReply with the number.` });
  }
}
async function sendPricing(jid) {
  const settings = store.getSettings();
  const services = settings.clinic.services || [];
  const priceList = services
    .map((s) => `• ${s.label}: ${s.price ? `from ${settings.business.currencySymbol}${s.price}` : 'ask our team'}`)
    .join('\n');
  const text = store.renderText('pricing_intro', { price_list: priceList });
  const patient = store.getPatient(jid);
  patient.pricing_viewed_at = new Date().toISOString();
  patient.lead_followup_1_sent = false;
  patient.lead_followup_2_sent = false;
  store.savePatient(patient);
  if (showButtons()) {
    await sendWithDelay(jid, {
      text, footer: settings.business.name,
      nativeFlow: [
        { text: '📅 Book Appointment', id: 'book' },
        { text: '❓ Ask Another Question', id: 'question' },
        { text: '🙋 Talk to Staff', id: 'staff' },
      ],
    });
  } else {
    await sendWithDelay(jid, { text: `${text}\n\n1 — Book Appointment\n2 — Ask Another Question\n3 — Talk to Staff` });
  }
}
async function sendDayPicker(jid, days) {
  // FIX: agar upcoming window ke sab din fully-booked nikle (availability filter ke baad
  // list khaali ho), to khaali WhatsApp list bhejne ke bajaye clear message do.
  if (!days.length) {
    await sendWithDelay(jid, {
      text: `Sorry, we don't have any openings in the next few days. Please message us directly and we'll try to fit you in.`,
      footer: store.getSettings().business.name,
      nativeFlow: [{ text: '🏠 Menu', id: 'menu' }],
    });
    return;
  }
  const text = store.renderText('appointment_date');
  const rows = days.map((d) => ({ title: store.dayLabel(d), description: d, rowId: `day:${d}` }));
  if (showButtons()) {
    await sendWithDelay(jid, {
      text, footer: store.getSettings().business.name,
      buttonText: '📅 Choose a day', title: 'Select a date',
      sections: [{ title: 'Available days', rows }],
    });
  } else {
    const list = days.map((d, i) => `${i + 1} — ${store.dayLabel(d)} (${d})`).join('\n');
    await sendWithDelay(jid, { text: `${text}\n\n${list}\n\nReply with the number.` });
  }
}
async function sendSlotPicker(jid, date, slots) {
  const text = store.renderText('appointment_time', { day: store.dayLabel(date) });
  if (!slots.length) {
    await sendWithDelay(jid, { text: `Sorry, ${store.dayLabel(date)} is fully booked. Please pick another day.`, footer: store.getSettings().business.name, nativeFlow: [{ text: '📅 Other days', id: 'book' }] });
    return;
  }
  const rows = slots.map((t) => ({ title: t, description: 'Available', rowId: `time:${date}:${t}` }));
  if (showButtons()) {
    await sendWithDelay(jid, {
      text, footer: store.getSettings().business.name,
      buttonText: '🕐 Choose a time', title: `${store.dayLabel(date)} — available times`,
      sections: [{ title: 'Slots', rows }],
    });
  } else {
    const list = slots.map((t, i) => `${i + 1} — ${t}`).join('\n');
    await sendWithDelay(jid, { text: `${text}\n\n${list}\n\nReply with the number.` });
  }
}
async function sendPractitionerPicker(jid) {
  const practitioners = store.getSettings().clinic.practitioners || ['Any available'];
  const text = store.renderText('appointment_practitioner');
  if (showButtons()) {
    const flow = practitioners.slice(0, 4).map((p) => ({ text: p, id: `prac:${p}` }));
    await sendWithDelay(jid, { text, footer: store.getSettings().business.name, nativeFlow: flow });
  } else {
    const list = practitioners.map((p, i) => `${i + 1} — ${p}`).join('\n');
    await sendWithDelay(jid, { text: `${text}\n\n${list}\n\nReply with the number.` });
  }
}

const chats = new Map();
function getState(jid) {
  if (!chats.has(jid)) chats.set(jid, { stage: 'welcome', data: {} });
  return chats.get(jid);
}
async function notifyAdmin(text) {
  const jid = store.adminJid();
  if (!jid) return;
  await enqueueSend(jid, { text }, { skipTyping: true, noCount: true, allowOptedOut: true });
}
async function handleOptOut(jid, state) {
  const patient = store.getPatient(jid);
  patient.opted_in = false;
  patient.consent_timestamp = null;
  store.savePatient(patient);
  state.stage = 'main';
  await enqueueSend(jid, { text: store.renderText('opted_out') }, { skipTyping: true, allowOptedOut: true, logOut: true });
  log('info', `${jid} opted out via STOP`);
}
async function handleConsent(jid, state, text) {
  const ans = text.trim().toUpperCase();
  if (ans === 'YES' || ans === 'Y') {
    const patient = store.getPatient(jid);
    patient.opted_in = true;
    patient.consent_timestamp = new Date().toISOString();
    store.savePatient(patient);
    state.stage = 'main';
    await sendMainMenu(jid);
  } else if (ans === 'NO' || ans === 'N') {
    const patient = store.getPatient(jid);
    patient.opted_in = false;
    store.savePatient(patient);
    state.stage = 'welcome';
    await enqueueSend(jid, { text: 'Understood — we won\'t send automated messages. You can still reach us anytime.' }, { skipTyping: true, allowOptedOut: true, logOut: true });
  } else {
    await sendConsentRequest(jid);
  }
}
async function startBooking(jid, state) {
  state.stage = 'select_service';
  state.data = {};
  await sendServicePicker(jid);
}
async function selectService(jid, state, serviceId) {
  const services = store.getSettings().clinic.services || [];
  const svc = services.find((s) => s.id === serviceId) || { label: serviceId };
  state.data.service = svc.label;
  const patient = store.getPatient(jid);
  if (!patient.name) {
    state.stage = 'ask_name';
    await sendWithDelay(jid, { text: store.renderText('ask_name') });
    return;
  }
  await proceedToPhone(jid, state, patient);
}
async function proceedToPhone(jid, state, patient) {
  if (patient.phone) {
    state.stage = 'confirm_phone';
    if (showButtons()) {
      await sendWithDelay(jid, {
        text: store.renderText('confirm_phone'),
        footer: store.getSettings().business.name,
        nativeFlow: [{ text: '✅ Yes, that\'s right', id: 'phone_yes' }, { text: '📱 Use another number', id: 'phone_other' }],
      });
    } else {
      await sendWithDelay(jid, { text: `${store.renderText('confirm_phone')}\n\n1 — Yes\n2 — Use another number` });
    }
  } else {
    state.stage = 'ask_phone';
    await sendWithDelay(jid, { text: store.renderText('ask_phone', { name: patient.name || 'there' }) });
  }
}
async function proceedToDay(jid, state) {
  const days = store.upcomingDaysWithAvailability(store.getSettings().clinic.booking_days_ahead);
  state.stage = 'select_day';
  await sendDayPicker(jid, days);
}
async function selectDay(jid, state, dateStr) {
  const slots = store.availableSlots(dateStr);
  state.stage = 'select_time';
  state.data.date = dateStr;
  await sendSlotPicker(jid, dateStr, slots);
}
async function selectTime(jid, state, timeStr) {
  const date = state.data.date;
  if (store.isSlotTaken(date, timeStr)) {
    await sendSlotPicker(jid, date, store.availableSlots(date));
    return;
  }
  state.data.time = timeStr;
  await sendBookingSummary(jid, state);
}
async function sendBookingSummary(jid, state) {
  const { date, time, service } = state.data;
  const patient = store.getPatient(jid);
  state.stage = 'confirm_booking';
  const text = store.renderText('booking_summary', { service, day: store.dayLabel(date), time, name: patient.name || 'there' });
  if (showButtons()) {
    await sendWithDelay(jid, {
      text, footer: store.getSettings().business.name,
      nativeFlow: [
        { text: '✅ Confirm Appointment', id: 'confirm_book' },
        { text: '🕐 Change Time', id: 'change_time' },
        { text: '❌ Cancel', id: 'cancel_booking' },
      ],
    });
  } else {
    await sendWithDelay(jid, { text: `${text}\n\n1 — Confirm\n2 — Change Time\n3 — Cancel` });
  }
}
async function finalizeBooking(jid, state) {
  const { date, time, service } = state.data;
  const practitioner = 'Any available';
  // FIX: "Confirm" dabane ke waqt dobara check — agar iss beech koi aur customer
  // yehi slot le chuka ho (race condition), to double-booking hone se roko.
  if (store.isSlotTaken(date, time)) {
    await sendWithDelay(jid, { text: `Sorry, that slot was just taken by someone else. Please pick another time.` });
    return sendSlotPicker(jid, date, store.availableSlots(date));
  }
  const { patient } = store.bookSlot({ jid, date, time, practitioner });
  const formatted = store.formatAppointmentTime(date, time);
  const text = store.renderText('appointment_confirmed', { appointment_time: formatted, practitioner, service });
  await sendWithDelay(jid, {
    text, footer: store.getSettings().business.name,
    nativeFlow: [{ text: '📅 Book another', id: 'book' }, { text: '🏠 Main menu', id: 'menu' }],
  });
  if (store.shouldNotifyAdmin('notifyNewAppointment')) {
    await notifyAdmin(`🆕 *New appointment*\n\n👤 ${patient.name || 'Unknown'}\n📞 ${patient.phone || jid}\n📅 ${formatted}\n🩺 ${service || practitioner}`);
  }
  state.stage = 'main';
  state.data = {};
}
async function startReschedule(jid, state) {
  const appt = store.findAppointment(jid);
  if (!appt) {
    await sendWithDelay(jid, { text: 'You don\'t have an upcoming appointment to reschedule. Tap below to book one.' });
    state.stage = 'main';
    return;
  }
  state.stage = 'reschedule_day';
  state.data.rescheduleId = appt.id;
  const days = store.upcomingDaysWithAvailability(store.getSettings().clinic.booking_days_ahead);
  await sendWithDelay(jid, { text: `Your current appointment: *${store.formatAppointmentTime(appt.date, appt.time)}*.\n\n${store.renderText('reschedule_prompt')}` });
  await sendDayPicker(jid, days);
}
async function startCancel(jid, state) {
  const appt = store.findAppointment(jid);
  if (!appt) {
    await sendWithDelay(jid, { text: 'You don\'t have an upcoming appointment to cancel.' });
    state.stage = 'main';
    return;
  }
  const formatted = store.formatAppointmentTime(appt.date, appt.time);
  if (showButtons()) {
    await sendWithDelay(jid, {
      text: `Are you sure you want to cancel your appointment on *${formatted}*?`,
      footer: store.getSettings().business.name,
      nativeFlow: [{ text: '✅ Yes, cancel it', id: `cancel_confirm:${appt.id}` }, { text: '↩️ Keep it', id: 'menu' }],
    });
  } else {
    state.stage = 'cancel_confirm';
    state.data.cancelId = appt.id;
    await sendWithDelay(jid, { text: `Cancel appointment on ${formatted}? Reply YES or NO.` });
  }
}
async function doCancel(jid, appointmentId) {
  const patient = store.getPatient(jid);
  const appt = (patient.appointments || []).find((a) => a.id === appointmentId);
  store.cancelAppointment(jid, appointmentId);
  const formatted = appt ? store.formatAppointmentTime(appt.date, appt.time) : 'your appointment';
  await sendWithDelay(jid, {
    text: store.renderText('appointment_cancelled', { appointment_time: formatted }),
    footer: store.getSettings().business.name,
    nativeFlow: [{ text: '📅 Book again', id: 'book' }, { text: '🏠 Menu', id: 'menu' }],
  });
  if (store.shouldNotifyAdmin('notifyCancellation')) {
    await notifyAdmin(`❌ *Appointment cancelled*\n\n👤 ${patient.name || 'Unknown'}\n📞 ${patient.phone || jid}\n📅 ${formatted}`);
  }
}
async function sendInfo(jid) {
  const s = store.getSettings();
  await sendWithDelay(jid, {
    text: `🕐 *Opening hours*\n${s.clinic.hours_open}–${s.clinic.hours_close} (${(s.clinic.open_days || []).join(', ')})\n\n📍 *Location*\n${s.clinic.location}\n\n🚨 *Emergencies*\n${s.clinic.emergency_contact}`,
    footer: s.business.name,
    nativeFlow: [{ text: '🏠 Back to menu', id: 'menu' }],
  });
}
function isClinicOpen() {
  const s = store.getSettings();
  const { hours_open, hours_close, timezone, open_days } = s.clinic;
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
    const parts = fmt.formatToParts(now);
    const hours = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    const mins = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    const dow = parts.find((p) => p.type === 'weekday').value;
    const cur = hours * 60 + mins;
    if (open_days?.length && !open_days.some((d) => d.toLowerCase() === dow.toLowerCase())) return false;
    const [oh, om] = hours_open.split(':').map(Number);
    const [ch, cm] = hours_close.split(':').map(Number);
    return cur >= oh * 60 + om && cur < ch * 60 + cm;
  } catch (err) {
    log('error', `Timezone check failed: ${err.message}. Defaulting to open.`);
    return true;
  }
}

async function handleText(jid, rawText, state) {
  const text = rawText.trim();
  const lower = text.toLowerCase();
  if (lower === 'stop' || lower === 'unsubscribe') { await handleOptOut(jid, state); return; }
  if (state.stage !== 'consent_pending' && (lower === 'yes' || lower === 'opt in')) {
    const patient = store.getPatient(jid);
    if (!patient.opted_in) {
      patient.opted_in = true;
      patient.consent_timestamp = new Date().toISOString();
      store.savePatient(patient);
      await enqueueSend(jid, { text: '✅ Welcome back! You\'re opted in. Tap below to continue.' }, { skipTyping: true });
      await sendMainMenu(jid);
      return;
    }
  }
  if (state.stage === 'consent_pending') { await handleConsent(jid, state, text); return; }
  // FIX: pehle "opted_in:false" wala patient agar seedha 'book'/'pricing' jaisa button
  // dabata tha (menu se pehle), to sendWithDelay chup chaap message drop kar deta tha —
  // patient ko koi reply hi nahi milta tha. Ab har action se pehle consent maango.
  const currentPatient = store.getPatient(jid);
  if (!currentPatient.opted_in) {
    state.stage = 'consent_pending';
    await sendConsentRequest(jid);
    return;
  }
  if (['menu', 'start', 'help', 'hi', 'hello', 'hey'].includes(lower) || state.stage === 'welcome') {
    const patient = store.getPatient(jid);
    if (!patient.consent_timestamp && patient.opted_in) {
      state.stage = 'consent_pending';
      await sendConsentRequest(jid);
      return;
    }
    if (!patient.opted_in) {
      state.stage = 'consent_pending';
      await sendConsentRequest(jid);
      return;
    }
    state.stage = 'main';
    await sendMainMenu(jid);
    return;
  }
  if (text.startsWith('day:')) {
    const date = text.slice(4);
    if (state.stage === 'select_day') return selectDay(jid, state, date);
    if (state.stage === 'reschedule_day') { state.stage = 'reschedule_time'; state.data.date = date; return sendSlotPicker(jid, date, store.availableSlots(date)); }
  }
  if (text.startsWith('time:')) {
    const parts = text.split(':');
    const date = parts[1]; const time = parts.slice(2).join(':'); // FIX: time khud "09:00" hai, isliye baaki parts wapas join karo
    if (state.stage === 'select_time') return selectTime(jid, state, time);
    if (state.stage === 'reschedule_time') {
      if (store.isSlotTaken(date, time, jid)) return sendSlotPicker(jid, date, store.availableSlots(date));
      const old = store.findAppointment(jid, { id: state.data.rescheduleId });
      if (old) store.updateAppointment(jid, old.id, { date, time, status: 'confirmed' });
      await sendWithDelay(jid, { text: `✅ Rescheduled to *${store.formatAppointmentTime(date, time)}*.`, footer: store.getSettings().business.name, nativeFlow: [{ text: '🏠 Menu', id: 'menu' }] });
      state.stage = 'main'; state.data = {};
      return;
    }
  }
  if (text.startsWith('svc:')) {
    if (state.stage === 'select_service') return selectService(jid, state, text.slice(4));
  }
  if (text.startsWith('cancel_confirm:')) return doCancel(jid, text.slice(15));
  if (text.startsWith('confirm_apt:')) {
    const appt = store.findAppointment(jid, { id: text.slice(12) });
    if (appt) await sendWithDelay(jid, { text: `Thanks for confirming! See you on *${store.formatAppointmentTime(appt.date, appt.time)}* ✅`, footer: store.getSettings().business.name, nativeFlow: [{ text: '🏠 Menu', id: 'menu' }] });
    return;
  }
  if (text === 'book') return startBooking(jid, state);
  if (text === 'reschedule') return startReschedule(jid, state);
  if (text === 'cancel') return startCancel(jid, state);
  if (text === 'question') { state.stage = 'question_pending'; await sendWithDelay(jid, { text: store.renderText('question_prompt') }); return; }
  if (text === 'pricing') return sendPricing(jid);
  if (text === 'staff') { await sendWithDelay(jid, { text: store.renderText('staff_prompt') }); if (store.shouldNotifyAdmin('notifyTalkToStaff')) await notifyAdmin(`🙋 *${store.getPatient(jid).name || jid}* (${store.getPatient(jid).phone || jid}) requested a human agent.`); return; }
  if (text === 'info') return sendInfo(jid);
  if (text === 'menu') { state.stage = 'main'; return sendMainMenu(jid); }
  if (text === 'review') { await sendWithDelay(jid, { text: `We'd love your feedback! 🌟\n👉 ${store.getSettings().clinic.google_review_link}` }); return; }
  if (state.stage === 'main') {
    if (text === '1') return startBooking(jid, state);
    if (text === '2') { state.stage = 'question_pending'; return sendWithDelay(jid, { text: store.renderText('question_prompt') }); }
    if (text === '3') return sendPricing(jid);
    if (text === '4') { await sendWithDelay(jid, { text: store.renderText('staff_prompt') }); if (store.shouldNotifyAdmin('notifyTalkToStaff')) await notifyAdmin(`🙋 ${store.getPatient(jid).name || jid} requested a human agent.`); return; }
    if (text === '5') return handleOptOut(jid, state);
    return sendMainMenu(jid);
  }
  if (state.stage === 'select_service') {
    const services = store.getSettings().clinic.services || [];
    const n = parseInt(text, 10);
    if (n >= 1 && n <= services.length) return selectService(jid, state, services[n - 1].id);
    return sendServicePicker(jid);
  }
  if (state.stage === 'select_day') {
    const days = store.upcomingDaysWithAvailability(store.getSettings().clinic.booking_days_ahead);
    const n = parseInt(text, 10);
    if (n >= 1 && n <= days.length) return selectDay(jid, state, days[n - 1]);
    return sendDayPicker(jid, days);
  }
  if (state.stage === 'select_time') {
    const slots = store.availableSlots(state.data.date);
    const n = parseInt(text, 10);
    if (n >= 1 && n <= slots.length) return selectTime(jid, state, slots[n - 1]);
    return sendSlotPicker(jid, state.data.date, slots);
  }
  if (state.stage === 'ask_name') {
    const patient = store.getPatient(jid);
    patient.name = text.slice(0, 60);
    store.savePatient(patient);
    return proceedToPhone(jid, state, patient);
  }
  if (state.stage === 'confirm_phone') {
    if (text === 'phone_yes' || lower === '1' || lower === 'yes') return proceedToDay(jid, state);
    if (text === 'phone_other' || lower === '2') {
      state.stage = 'ask_phone';
      await sendWithDelay(jid, { text: 'No problem — what number should we use instead?' });
      return;
    }
    return proceedToPhone(jid, state, store.getPatient(jid));
  }
  if (state.stage === 'ask_phone') {
    const patient = store.getPatient(jid);
    patient.phone = text.replace(/[^\d+]/g, '').slice(0, 20) || patient.phone;
    store.savePatient(patient);
    return proceedToDay(jid, state);
  }
  if (state.stage === 'confirm_booking') {
    if (text === 'confirm_book' || lower === '1' || lower === 'confirm') return finalizeBooking(jid, state);
    if (text === 'change_time' || lower === '2') { state.stage = 'select_time'; return sendSlotPicker(jid, state.data.date, store.availableSlots(state.data.date)); }
    if (text === 'cancel_booking' || lower === '3' || lower === 'cancel') {
      state.stage = 'main'; state.data = {};
      await sendWithDelay(jid, { text: store.renderText('booking_cancelled_predraft') });
      return;
    }
    return sendBookingSummary(jid, state);
  }
  if (state.stage === 'reschedule_day') {
    const days = store.upcomingDaysWithAvailability(store.getSettings().clinic.booking_days_ahead);
    const n = parseInt(text, 10);
    if (n >= 1 && n <= days.length) { state.stage = 'reschedule_time'; state.data.date = days[n - 1]; return sendSlotPicker(jid, days[n - 1], store.availableSlots(days[n - 1])); }
    return sendDayPicker(jid, days);
  }
  if (state.stage === 'reschedule_time') {
    const date = state.data.date;
    const slots = store.availableSlots(date);
    const n = parseInt(text, 10);
    if (n >= 1 && n <= slots.length) {
      const time = slots[n - 1];
      const old = store.findAppointment(jid, { id: state.data.rescheduleId });
      if (old) store.updateAppointment(jid, old.id, { date, time, status: 'confirmed' });
      await sendWithDelay(jid, { text: `✅ Rescheduled to *${store.formatAppointmentTime(date, time)}*.`, footer: store.getSettings().business.name, nativeFlow: [{ text: '🏠 Menu', id: 'menu' }] });
      state.stage = 'main'; state.data = {};
      return;
    }
    return sendSlotPicker(jid, date, slots);
  }
  if (state.stage === 'cancel_confirm') {
    if (['yes', 'y'].includes(lower)) { await doCancel(jid, state.data.cancelId); state.stage = 'main'; state.data = {}; return; }
    state.stage = 'main'; return sendMainMenu(jid);
  }
  if (state.stage === 'question_pending') {
    await sendWithDelay(jid, { text: 'Thanks — we\'ve received your question and our clinical team will reply shortly. 👍' });
    if (store.shouldNotifyAdmin('notifyQuestion')) await notifyAdmin(`❓ *Question from ${store.getPatient(jid).name || jid}* (${store.getPatient(jid).phone || jid}):\n\n${text.slice(0, 500)}`);
    state.stage = 'main';
    return;
  }
  await sendWithDelay(jid, {
    text: store.renderText('fallback'),
    footer: store.getSettings().business.name,
    nativeFlow: [{ text: '🏠 Menu', id: 'menu' }, { text: '🚫 Stop Messages', id: 'STOP' }],
  });
}

async function onMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return;
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  if (jid.endsWith('@g.us') && !store.getSettings().behavior.replyToGroups) return;
  const text = extractText(msg).trim();
  if (!text) return;
  store.bumpStat('messagesIn');
  store.touchPatient(jid, { pushName: msg.pushName, senderPn: msg.key.senderPn });
  store.logChatEvent({ direction: 'in', jid, name: msg.pushName || '', text });
  log('chat', `${msg.pushName || jid}: ${text.slice(0, 120)}`);
  if (store.getSettings().behavior.sendReadReceipts) {
    try { await runtime.sock?.readMessages([msg.key]); } catch (_) {}
  }
  if (!store.getSettings().behavior.autoReplyEnabled) return;

  const state = getState(jid);

  // FIX 1: consent pending pe after_hours kabhi mat bhejo
  // FIX 2: YES/NO aur saare button ids ko after_hours se exclude
  const lowerTap = text.toLowerCase();
  const isButtonTap = ['YES','NO','yes','no','STOP','book','info','reschedule','cancel','question','pricing','staff','menu','review','phone_yes','phone_other','confirm_book','change_time','cancel_booking'].includes(text)
    || text.startsWith('day:') || text.startsWith('time:') || text.startsWith('svc:') || text.startsWith('cancel_confirm:') || text.startsWith('confirm_apt:');
  const isStopCommand = lowerTap === 'stop' || lowerTap === 'unsubscribe';
  // Sirf idle patient (welcome/main) ko after-hours message milta hai. Beech flow (naam/phone/
  // question likhte waqt) ya STOP kabhi intercept nahi hota — warna form reset ho jata hai.
  const isIdle = state.stage === 'welcome' || state.stage === 'main';

  if (isIdle && !isStopCommand && !isClinicOpen() && store.getSettings().automation.after_hours_responder && !isButtonTap) {
    const text2 = store.renderText('after_hours');
    if (showButtons()) {
      await enqueueSend(jid, {
        text: text2, footer: store.getSettings().business.name,
        nativeFlow: [
          { text: '📅 Book for Tomorrow', id: 'book' },
          { text: '🕐 Hours & Location', id: 'info' },
          { text: '❓ Ask a Question', id: 'question' },
        ],
      }, { skipTyping: true, logOut: true });
    } else {
      await enqueueSend(jid, { text: text2 + '\n\n1 — Book\n2 — Hours\n3 — Question' }, { skipTyping: true, logOut: true });
    }
    return;
  }

  void withChatLock(jid, () => handleText(jid, text, state));
}

async function sendAppointmentReminders() {
  const settings = store.getSettings();
  const patients = store.listPatients();
  const tz = settings.clinic.timezone;
  const inTz = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return new Date(d.toLocaleString('en-US', { timeZone: tz })).toISOString().slice(0, 10);
  };
  const tomorrow = inTz(1);
  for (const patient of patients) {
    if (!patient.opted_in) continue;
    for (const a of patient.appointments || []) {
      if (a.cancelled || a.completed) continue;
      if (settings.automation.reminder_24h && a.date === tomorrow && !a.reminder_sent) {
        const formatted = store.formatAppointmentTime(a.date, a.time);
        await sendWithDelay(patient.jid, {
          text: store.renderText('reminder_24h', { greeting: getGreeting(), name: patient.name || 'there', appointment_time: formatted }),
          footer: settings.business.name,
          nativeFlow: [{ text: '✅ Confirm', id: `confirm_apt:${a.id}` }, { text: '🔁 Reschedule', id: 'reschedule' }],
        });
        a.reminder_sent = true; store.savePatient(patient); store.bumpStat('remindersQueued');
      }
      if (settings.automation.reminder_2h && a.date === inTz(0) && !a.reminder_2h_sent) {
        try {
          const [hh, mm] = a.time.split(':').map(Number);
          const now = new Date();
          const nowTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
          const apptMinutes = hh * 60 + mm;
          const nowMinutes = nowTz.getHours() * 60 + nowTz.getMinutes();
          if (apptMinutes - nowMinutes > 0 && apptMinutes - nowMinutes <= 130) {
            await sendWithDelay(patient.jid, { text: store.renderText('reminder_2h', { greeting: getGreeting(), name: patient.name || 'there', appointment_time: a.time }) });
            a.reminder_2h_sent = true; store.savePatient(patient);
          }
        } catch (_) {}
      }
    }
  }
}
async function sendReviewRequests() {
  const settings = store.getSettings();
  if (!settings.automation.google_review) return;
  const delayMs = (settings.automation.review_delay_hours || 2) * 3600 * 1000;
  const patients = store.listPatients();
  for (const patient of patients) {
    if (!patient.opted_in) continue;
    for (const a of patient.appointments || []) {
      if (a.completed && !a.review_sent && a.completed_at && Date.now() - new Date(a.completed_at).getTime() > delayMs) {
        await sendWithDelay(patient.jid, { text: store.renderText('review_request', { greeting: getGreeting(), name: patient.name || 'there', review_link: settings.clinic.google_review_link }) });
        a.review_sent = true; store.savePatient(patient); store.bumpStat('reviewsRequested');
      }
    }
  }
}
async function sendLeadFollowups() {
  const settings = store.getSettings();
  const patients = store.listPatients();
  const now = Date.now();
  for (const patient of patients) {
    if (!patient.opted_in || !patient.pricing_viewed_at) continue;
    const hasUpcoming = (patient.appointments || []).some((a) => !a.cancelled && !a.completed);
    if (hasUpcoming) continue; // already booked — no need to chase
    const elapsedHrs = (now - new Date(patient.pricing_viewed_at).getTime()) / 3600000;
    if (!patient.lead_followup_1_sent && elapsedHrs >= 3) {
      await sendWithDelay(patient.jid, { text: store.renderText('lead_followup_hours', { greeting: getGreeting(), name: patient.name || 'there' }) });
      patient.lead_followup_1_sent = true; store.savePatient(patient);
    } else if (!patient.lead_followup_2_sent && elapsedHrs >= 24) {
      await sendWithDelay(patient.jid, { text: store.renderText('lead_followup_nextday', { greeting: getGreeting(), name: patient.name || 'there' }) });
      patient.lead_followup_2_sent = true; store.savePatient(patient);
    }
  }
}
function detachSocket() {
  if (!runtime.sock) return;
  try { runtime.sock.ev.removeAllListeners(); } catch (_) {}
  try { runtime.sock.end(undefined); } catch (_) {}
  runtime.sock = null;
}
async function start() {
  if (runtime.busy) return { ok: false, message: 'Already starting, please wait.' };
  if (isConnected()) return { ok: true, message: 'Already connected.' };
  runtime.busy = true; runtime.manualStop = false; runtime.lastError = null; runtime.status = 'starting';
  log('info', 'Starting Baileys connection...');
  try {
    detachSocket();
    // FIX: agar local session khaali hai (jaisa har deploy ke baad Free-plan pe hota hai),
    // pehle Google Sheet se restore try karo — taake QR dobara scan na karna pade.
    try {
      const restored = await store.restoreSessionFromSheetIfEmpty();
      if (restored.ok) log('info', restored.message);
    } catch (err) {
      log('warn', `Session restore from sheet failed: ${err.message}`);
    }
    const { state: authState, saveCreds } = await useMultiFileAuthState(store.PATHS.auth);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { version = [2, 3000, 1015901307]; }
    const sock = makeWASocket({
      version,
      auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, logger) },
      logger, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
      browser: ['ClinicBot', 'Chrome', '120.0.0'],
    });
    runtime.sock = sock;
    sock.ev.on('creds.update', async (...args) => {
      await saveCreds(...args);
      // FIX: session file update hote hi (debounced) sheet pe bhi backup bhej do.
      store.scheduleSessionBackup();
    });
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        runtime.status = 'qr'; runtime.qrGeneratedAt = new Date().toISOString();
        try { runtime.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); log('info', 'New QR generated — scan to link device.'); } catch (err) { log('error', `QR render failed: ${err.message}`); }
      }
      if (connection === 'open') {
        runtime.status = 'connected'; runtime.qrDataUrl = null; runtime.connectedAt = new Date().toISOString();
        runtime.reconnectAttempts = 0; runtime.me = { id: sock.user?.id || null, name: sock.user?.name || sock.user?.verifiedName || null };
        log('info', `Connected as ${runtime.me.name || runtime.me.id}`); store.sheets.logEvent('info', 'Bot connected to WhatsApp');
        store.scheduleSessionBackup(3000); // FIX: connect hote hi jald backup taake fresh pairing turant safe ho jaye
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode; const reason = lastDisconnect?.error?.message || 'closed';
        runtime.qrDataUrl = null;
        if (runtime.manualStop) { runtime.status = 'stopped'; log('info', 'Bot stopped.'); return; }
        if (code === DisconnectReason.loggedOut) {
          runtime.status = 'stopped'; runtime.lastError = 'Device logged out. Scan QR again.';
          store.clearSession();
          void store.sheets.clearSessionRemote(); // FIX: purani (ab invalid) session sheet se bhi hata do — warna agla restore usi ko dobara le aayega
          log('warn', runtime.lastError); return;
        }
        runtime.reconnectAttempts += 1; runtime.status = 'reconnecting'; runtime.lastError = `${reason} (code ${code})`;
        const backoff = Math.min(60000, 3000 * runtime.reconnectAttempts);
        log('warn', `Disconnected: ${runtime.lastError}. Retrying in ${backoff / 1000}s`);
        setTimeout(() => { if (!runtime.manualStop) void start(); }, backoff).unref?.();
      }
    });
    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages || []) {
        const jid = msg.key?.remoteJid; if (!jid) continue;
        void withChatLock(jid, () => onMessage(msg));
      }
    });
    return { ok: true, message: 'Bot started. Scan the QR code.' };
  } catch (err) {
    runtime.status = 'stopped'; runtime.lastError = err.message;
    log('error', `Start failed: ${err.message}`);
    return { ok: false, message: err.message };
  } finally { runtime.busy = false; }
}
async function stop() {
  runtime.manualStop = true; detachSocket();
  runtime.status = 'stopped'; runtime.qrDataUrl = null; runtime.me = null; runtime.connectedAt = null;
  log('info', 'Bot stopped manually.'); return { ok: true, message: 'Bot stopped.' };
}
async function logout() {
  runtime.manualStop = true;
  try { if (runtime.sock) await runtime.sock.logout(); } catch (_) {}
  detachSocket(); const removed = store.clearSession();
  void store.sheets.clearSessionRemote(); // FIX: manual logout pe bhi sheet-side backup saaf karo
  runtime.status = 'stopped'; runtime.qrDataUrl = null; runtime.me = null; runtime.connectedAt = null;
  log('info', `Session cleared (${removed} files).`); return { ok: true, message: 'Logged out and session cleared.' };
}
async function sendManual(target, text) {
  if (!isConnected()) return { ok: false, message: 'Bot is not connected.' };
  const jid = jidFromNumber(target);
  if (!jid) return { ok: false, message: 'Invalid phone format.' };
  if (!String(text || '').trim()) return { ok: false, message: 'Message is empty.' };
  const result = await enqueueSend(jid, { text: String(text).trim() }, { skipTyping: true, allowOptedOut: true });
  if (result.ok) { store.touchPatient(jid); store.logChatEvent({ direction: 'out', jid, name: '', text: String(text).trim() }); log('info', `Manual message sent to ${jid}`); return { ok: true, message: 'Sent successfully.' }; }
  return { ok: false, message: result.error || 'Failed' };
}
function shutdown() { try { store.flushStats(); } catch (_) {} }
module.exports = { start, stop, logout, getStatus, getLogs, isConnected, sendManual, shutdown, sendAppointmentReminders, sendReviewRequests, sendLeadFollowups, isClinicOpen, _internals: { handleText, getState, onMessage, runtime, extractText } };
