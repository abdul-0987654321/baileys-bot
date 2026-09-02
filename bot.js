'use strict';
/**
 * bot.js — the WhatsApp side, wrapped in something the dashboard can drive.
 *
 * Nothing in here reads a hardcoded config: the admin number, the rate limits
 * and every single reply string come from store.js, which the dashboard edits.
 *
 * Fixes carried over from v3 (see README "What was broken"):
 *  - only messages with upsert type "notify" are handled, so a reconnect can't
 *    replay old chats and re-spam customers
 *  - message IDs are de-duplicated across restarts
 *  - reconnects build a fresh socket and drop the old listeners, so handlers
 *    don't stack up and send everything twice
 *  - one global send queue instead of per-handler sleeps, so two customers
 *    can't interleave and the rate limit is actually respected
 *  - one lock per chat, so a customer double-tapping doesn't get double replies
 *  - the numbered list always matches the cards that were actually sent
 *  - the admin JID is resolved through onWhatsApp() instead of being built from
 *    digits (a fabricated JID makes Baileys log a successful send to nowhere)
 *  - an image that fails to download falls back to a text card instead of
 *    silently sending nothing
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const store = require('./store');

const logger = pino({ level: 'silent' });

/* ------------------------------------------------------------------ *
 * runtime status (what the dashboard polls)
 * ------------------------------------------------------------------ */

const runtime = {
  sock: null,
  status: 'stopped', // stopped | starting | qr | connected | reconnecting
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

function getLogs(limit = 200) {
  return logs.slice(-limit);
}

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
    autoReplyEnabled: store.getSettings().behavior.autoReplyEnabled,
  };
}

function isConnected() {
  return runtime.status === 'connected' && Boolean(runtime.sock);
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomDelay = (min, max) => sleep(randomBetween(min, max));

function keywordList(raw) {
  return String(raw || '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * A JID is an opaque string. Newer WhatsApp hands us `...@lid` values whose
 * digits are NOT a phone number, so we only ever build a JID when we started
 * from a bare number the agent typed in.
 */
function jidFromNumber(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (text.includes('@')) return text;
  const digits = text.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}

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

function isAfterHours() {
  const b = store.getSettings().behavior;
  if (!b.afterHoursEnabled) return false;
  const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm || '0:0').split(':').map((n) => parseInt(n, 10) || 0);
    return h * 60 + m;
  };
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(b.afterHoursFrom);
  const to = toMinutes(b.afterHoursTo);
  return from <= to ? current >= from && current < to : current >= from || current < to;
}

function decorate(text) {
  const { addRandomEmoji } = store.getSettings().rate;
  let out = text;
  if (isAfterHours()) out += store.renderText('afterHoursNote');
  if (!addRandomEmoji) return out;
  // Never append after markdown so *bold* and _italics_ don't break.
  if (/[*_~`]\s*$/.test(out)) return out;
  const fillers = ['', ' 🙂', ' 👍', ' ✅'];
  return out + fillers[Math.floor(Math.random() * fillers.length)];
}

/* ------------------------------------------------------------------ *
 * outgoing message queue — one worker, global order, honest rate limit
 * ------------------------------------------------------------------ */

const sendQueue = [];
let workerRunning = false;
const sendTimestamps = [];

function enqueueSend(jid, content, options = {}) {
  return new Promise((resolve) => {
    sendQueue.push({ jid, content, options, resolve });
    runtime.queueDepth = sendQueue.length;
    void runWorker();
  });
}

async function waitForRateWindow() {
  const { perMinuteLimit } = store.getSettings().rate;
  for (;;) {
    const now = Date.now();
    while (sendTimestamps.length && now - sendTimestamps[0] > 60000) sendTimestamps.shift();
    if (sendTimestamps.length < Math.max(1, perMinuteLimit)) return;
    await sleep(1500);
  }
}

async function deliver(job) {
  const { jid, content, options } = job;
  const settings = store.getSettings();
  const { rate, behavior } = settings;

  if (!runtime.sock) return { ok: false, error: 'not connected' };

  const payload = { ...content };
  if (payload.text && !options.raw) payload.text = decorate(payload.text);
  if (payload.caption && !options.raw) payload.caption = decorate(payload.caption);

  await waitForRateWindow();

  try {
    if (behavior.showTypingIndicator) {
      await runtime.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await randomDelay(rate.typingMinMs, rate.typingMaxMs);
    }
    await runtime.sock.sendMessage(jid, payload);
    if (behavior.showTypingIndicator) {
      await runtime.sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
    sendTimestamps.push(Date.now());
    store.bumpStat('messagesOut');
    if (payload.image) store.bumpStat('imagesOut');
    await randomDelay(rate.minDelayMs, rate.maxDelayMs);
    return { ok: true };
  } catch (err) {
    // A dead photo URL must not swallow the whole listing.
    if (payload.image && payload.caption) {
      log('warn', `Photo failed for ${jid} (${err.message}) — sending text card instead`);
      try {
        await runtime.sock.sendMessage(jid, { text: payload.caption });
        sendTimestamps.push(Date.now());
        store.bumpStat('messagesOut');
        await randomDelay(rate.minDelayMs, rate.maxDelayMs);
        return { ok: true, degraded: true };
      } catch (inner) {
        store.bumpStat('sendFailures');
        log('error', `Fallback text also failed for ${jid}: ${inner.message}`);
        return { ok: false, error: inner.message };
      }
    }
    store.bumpStat('sendFailures');
    log('error', `Send failed for ${jid}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (sendQueue.length) {
      const job = sendQueue.shift();
      runtime.queueDepth = sendQueue.length;
      const result = await deliver(job);
      job.resolve(result);
    }
  } finally {
    workerRunning = false;
    runtime.queueDepth = sendQueue.length;
  }
}

const sendText = (jid, text, options) => enqueueSend(jid, { text }, options);

async function notifyAdmin(text) {
  const jid = await resolveAdminJid();
  if (!jid) {
    log('warn', 'Lead came in but no admin number is set — nobody was notified.');
    return false;
  }
  const result = await enqueueSend(jid, { text }, { raw: true });
  return result.ok;
}

let adminJidCache = null;

async function resolveAdminJid() {
  const number = String(store.getSettings().admin.number || '').replace(/\D/g, '');
  if (!number) return null;
  if (adminJidCache && adminJidCache.number === number) return adminJidCache.jid;

  let jid = jidFromNumber(number);
  try {
    if (runtime.sock?.onWhatsApp) {
      const found = await runtime.sock.onWhatsApp(number);
      if (Array.isArray(found) && found[0]?.jid) {
        jid = found[0].jid;
        log('info', `Admin number resolved to ${jid}`);
      } else {
        log('warn', `${number} does not look like a WhatsApp account — notifications may not arrive.`);
      }
    }
  } catch (err) {
    log('warn', `Could not verify admin number: ${err.message}`);
  }
  adminJidCache = { number, jid };
  return jid;
}

/* ------------------------------------------------------------------ *
 * conversation state
 * ------------------------------------------------------------------ */

const chats = new Map();
const processedIds = new Set();
let persistTimer = null;

function hydrate() {
  const saved = store.loadConversations();
  for (const [jid, state] of Object.entries(saved.chats || {})) chats.set(jid, state);
  for (const id of saved.processedIds || []) processedIds.add(id);
  if (chats.size) log('info', `Restored ${chats.size} conversation(s) from disk`);
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const ids = Array.from(processedIds);
      store.saveConversations({
        chats: Object.fromEntries(chats),
        processedIds: ids.slice(-800),
      });
      store.flushStats();
    } catch (err) {
      log('error', `Could not save conversation state: ${err.message}`);
    }
  }, 800);
  persistTimer.unref?.();
}

function blankState() {
  return {
    stage: 'welcome',
    mode: 'current',
    suburb: null,
    minBeds: null,
    maxPrice: null,
    allIds: [],
    shownIds: [],
    pageStart: 0,
    widened: false,
    selectedId: null,
    shortlist: [],
    ref: null,
    contactName: null,
    contactPhone: null,
    preferredTime: null,
    sell: {},
    lastAgentRequestAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function getState(jid) {
  if (!chats.has(jid)) chats.set(jid, blankState());
  const state = chats.get(jid);
  if (!state.stage) Object.assign(state, blankState());
  return state;
}

function softReset(state) {
  // Keeps the shortlist and contact details, throws away the search.
  Object.assign(state, {
    stage: 'welcome',
    suburb: null,
    minBeds: null,
    maxPrice: null,
    allIds: [],
    shownIds: [],
    pageStart: 0,
    widened: false,
    selectedId: null,
  });
}

function listingById(id) {
  return store.getListings().find((l) => l.id === id) || null;
}

function ensureRef(state) {
  if (!state.ref) state.ref = `ANRE-${Date.now().toString().slice(-8)}`;
  return state.ref;
}

/* ------------------------------------------------------------------ *
 * message composition
 * ------------------------------------------------------------------ */

function menuBlock() {
  const t = store.getSettings().texts;
  return [t.menuItem1, t.menuItem2, t.menuItem3, t.menuItem4]
    .map((label, i) => `*${i + 1}️⃣ ${label}*`)
    .join('\n');
}

/**
 * CRM exports cut descriptions off mid-sentence ("...schools, shopping, transport and…").
 * Sending that to a buyer reads like a broken message, so we fall back to the last
 * complete sentence instead. This also clamps long descriptions typed into the
 * dashboard: WhatsApp rejects an image caption over ~1024 characters, and when that
 * happens the whole property card silently fails to send.
 */
function blurb(text, budget) {
  let out = String(text || '').trim();
  if (!out) return '';
  const lastSentenceEnd = (s) =>
    Math.max(s.lastIndexOf('. '), s.lastIndexOf('! '), s.lastIndexOf('? '));

  if (/(…|\.\.\.)$/.test(out)) {
    const cut = out.replace(/\s*(…|\.\.\.)$/, '');
    const stop = lastSentenceEnd(cut);
    // Only trim back if a decent amount of text survives — a short description
    // that happens to end in an ellipsis is better left alone than gutted.
    if (stop > 120) out = cut.slice(0, stop + 1);
  }

  if (out.length > budget) {
    const slice = out.slice(0, budget);
    const stop = lastSentenceEnd(slice);
    out = stop > budget * 0.5 ? slice.slice(0, stop + 1) : `${slice.trimEnd()}…`;
  }
  return out;
}

function propertyCaption(listing, index) {
  const price = store.formatPrice(listing);
  const specs =
    listing.bedrooms || listing.bathrooms || listing.parking
      ? `🛏️ ${listing.bedrooms ?? '-'} bed  |  🛁 ${listing.bathrooms ?? '-'} bath  |  🚗 ${listing.parking ?? '-'} car\n`
      : '';
  const land = listing.landSize && listing.landSize !== '0 m²' ? `📐 ${listing.landSize}\n` : '';
  const tag = listing.status === 'sold' ? '✅ SOLD' : '🏠 FOR SALE';
  const head = `*${index}. ${listing.title || listing.address}*\n${tag}\n📍 ${listing.address}\n💰 ${price}\n${specs}${land}`;
  const body = blurb(listing.description, Math.max(200, 1000 - head.length));
  return body ? `${head}\n${body}` : head.trimEnd();
}

async function sendResultPage(jid, state) {
  const { maxCardsShown, sendImages } = store.getSettings().behavior;
  const perPage = Math.max(1, Number(maxCardsShown) || 3);

  // Listings can be edited or deleted from the dashboard while someone browses.
  const live = state.allIds.map(listingById).filter(Boolean);
  state.allIds = live.map((l) => l.id);

  const page = live.slice(state.pageStart, state.pageStart + perPage);
  if (!page.length) {
    await sendText(jid, store.renderText('noMoreResults'));
    softReset(state);
    return;
  }

  // The numbers the customer sees are the numbers we can resolve. This is the
  // v3 bug: results held all 10 matches while only 6 cards were sent, so "7"
  // picked a property the customer never saw.
  state.shownIds = page.map((l) => l.id);
  state.stage = 'results';

  const headerKey = state.mode === 'sold'
    ? 'soldHeader'
    : state.widened ? 'resultsHeaderWidened' : 'resultsHeader';
  await sendText(
    jid,
    store.renderText(headerKey, {
      shown: `${state.pageStart + 1}-${state.pageStart + page.length}`,
      total: live.length,
    })
  );

  for (let i = 0; i < page.length; i += 1) {
    const listing = page[i];
    const caption = propertyCaption(listing, i + 1);
    if (sendImages && listing.heroImageUrl) {
      await enqueueSend(jid, { image: { url: listing.heroImageUrl }, caption });
    } else {
      await sendText(jid, caption);
    }
  }

  const hasMore = state.pageStart + page.length < live.length;
  const moreHint = hasMore ? ', or *more* for the next few' : '';
  await sendText(
    jid,
    store.renderText(state.mode === 'sold' ? 'soldFooter' : 'resultsFooter', { more: moreHint })
  );
}

async function startSearch(jid, state) {
  const criteria = {
    status: state.mode,
    suburb: state.suburb || 'any',
    minBeds: state.minBeds ?? 'any',
    maxPrice: state.maxPrice ?? 'any',
  };

  let matches = store.searchListings(criteria);
  state.widened = false;

  // Nothing in that suburb? Widen rather than dead-ending the lead.
  if (!matches.length && criteria.suburb !== 'any') {
    matches = store.searchListings({ ...criteria, suburb: 'any' });
    state.widened = matches.length > 0;
  }

  if (!matches.length) {
    state.stage = 'no_match';
    await sendText(jid, store.renderText('noMatch'));
    return;
  }

  state.allIds = matches.map((l) => l.id);
  state.pageStart = 0;
  await sendResultPage(jid, state);
}

function isValidPhone(text) {
  const digits = String(text).replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/* ------------------------------------------------------------------ *
 * lead completion
 * ------------------------------------------------------------------ */

async function finaliseVisit(jid, state) {
  const shortlist = state.shortlist.map(listingById).filter(Boolean);
  const record = store.saveInteraction(jid, {
    kind: 'visit_request',
    ref: ensureRef(state),
    contactName: state.contactName,
    contactPhone: state.contactPhone,
    preferredTime: state.preferredTime,
    shortlist: shortlist.map((l) => ({
      id: l.id,
      title: l.title || l.address,
      address: l.address,
      price: store.formatPrice(l),
    })),
  });

  await sendText(
    jid,
    store.renderText('visitDone', {
      ref: state.ref,
      name: state.contactName,
      phone: state.contactPhone,
      time: state.preferredTime,
      count: shortlist.length,
    })
  );

  if (store.getSettings().admin.notifyVisitRequest) {
    const lines = shortlist.map((l) => `  • ${l.title || l.address} — ${store.formatPrice(l)}`).join('\n');
    await notifyAdmin(
      `🔔 *NEW VISIT REQUEST*\n\n` +
        `Ref: ${state.ref}\n` +
        `Name: ${state.contactName}\n` +
        `Phone: ${state.contactPhone}\n` +
        `Preferred time: ${state.preferredTime}\n` +
        `WhatsApp: ${jid}\n` +
        `Total inquiries from this customer: ${record.interactions.length}\n\n` +
        `Shortlisted:\n${lines || '  (none)'}`
    );
  }

  log('info', `Visit request ${state.ref} saved for ${jid}`);
  const keep = { shortlist: [], contactName: state.contactName, contactPhone: state.contactPhone };
  Object.assign(state, blankState(), keep);
}

async function finaliseSeller(jid, state, phone) {
  const ref = ensureRef(state);
  const record = store.saveInteraction(jid, {
    kind: 'sell_lead',
    ref,
    contactName: state.sell.name,
    contactPhone: phone,
    propertyType: state.sell.type,
    location: state.sell.location,
    expectedPrice: state.sell.price,
  });

  await sendText(jid, store.renderText('sellDone', { ref, name: state.sell.name || '' }));

  if (store.getSettings().admin.notifySellerLead) {
    await notifyAdmin(
      `🔔 *NEW SELLER LEAD*\n\n` +
        `Reference: ${ref}\n` +
        `Name: ${state.sell.name}\n` +
        `Phone: ${phone}\n` +
        `Property type: ${state.sell.type}\n` +
        `Location: ${state.sell.location}\n` +
        `Expected price: ${state.sell.price}\n` +
        `WhatsApp: ${jid}\n` +
        `Total inquiries from this customer: ${record.interactions.length}`
    );
  }

  log('info', `Seller lead saved for ${jid}`);
  Object.assign(state, blankState());
}

async function requestAgent(jid, state, reason = '') {
  const cooldownMs = Math.max(0, Number(store.getSettings().admin.agentRequestCooldownMinutes) || 0) * 60000;
  const last = state.lastAgentRequestAt ? Date.parse(state.lastAgentRequestAt) : 0;
  if (cooldownMs && last && Date.now() - last < cooldownMs) {
    await sendText(jid, store.renderText('agentAlreadyNotified'));
    return;
  }
  state.lastAgentRequestAt = new Date().toISOString();
  store.saveInteraction(jid, { kind: 'agent_request', reason });

  await sendText(jid, store.renderText('agentNotified'));

  if (store.getSettings().admin.notifyAgentRequest) {
    const customer = store.getCustomer(jid);
    await notifyAdmin(
      `🔔 *AGENT REQUESTED*\n\n` +
        `WhatsApp: ${jid}\n` +
        `Name on record: ${customer.name || customer.pushName || 'not given yet'}\n` +
        `Shortlist: ${state.shortlist.length} property(ies)\n` +
        (reason ? `Context: ${reason}\n` : '') +
        `\nPlease message this customer directly.`
    );
  }
}

/* ------------------------------------------------------------------ *
 * the state machine
 * ------------------------------------------------------------------ */

async function handleText(jid, rawText, state) {
  const settings = store.getSettings();
  const text = rawText.trim();
  const lower = text.toLowerCase();
  const b = settings.behavior;

  // --- global keywords -------------------------------------------------
  if (keywordList(b.agentKeywords).includes(lower)) {
    await requestAgent(jid, state, `asked at stage "${state.stage}"`);
    return;
  }

  if (keywordList(b.shortlistKeywords).includes(lower)) {
    const items = state.shortlist.map(listingById).filter(Boolean);
    if (!items.length) {
      await sendText(jid, store.renderText('shortlistEmpty'));
    } else {
      const body = items
        .map((l, i) => `${i + 1}. ${l.title || l.address}\n   📍 ${l.address}\n   💰 ${store.formatPrice(l)}`)
        .join('\n\n');
      await sendText(jid, `📋 *YOUR SHORTLIST*\n\n${body}\n\nReply *menu* for a new search, or *agent* to talk to someone.`);
    }
    return;
  }

  const isReset = keywordList(b.resetKeywords).includes(lower);
  const isGreeting = keywordList(b.greetKeywords).includes(lower);
  // A greeting only resets when we're not mid-question — otherwise a seller
  // whose suburb answer happens to be "Hi" loses their whole form.
  const greetingCanReset = ['welcome', 'main', 'no_match', 'results'].includes(state.stage);

  if (isReset || (isGreeting && greetingCanReset)) {
    softReset(state);
  }

  // --- welcome ---------------------------------------------------------
  if (state.stage === 'welcome') {
    state.stage = 'main';
    await sendText(jid, store.renderText('welcome', { menu: menuBlock() }));
    return;
  }

  // --- main menu -------------------------------------------------------
  if (state.stage === 'main') {
    if (text === '1') {
      state.mode = 'current';
      state.stage = 'ask_suburb';
      await sendText(jid, store.renderText('askSuburbCurrent'));
      return;
    }
    if (text === '2') {
      state.mode = 'sold';
      state.stage = 'ask_suburb';
      await sendText(jid, store.renderText('askSuburbSold'));
      return;
    }
    if (text === '3') {
      state.stage = 'sell_type';
      await sendText(jid, store.renderText('askSellType'));
      return;
    }
    if (text === '4') {
      await requestAgent(jid, state, 'chose "Talk to an agent" from the menu');
      softReset(state);
      state.stage = 'main';
      return;
    }
    await sendText(jid, `${store.renderText('invalidMenu')}\n\n${menuBlock()}`);
    return;
  }

  // --- browse ----------------------------------------------------------
  if (state.stage === 'ask_suburb') {
    state.suburb = lower === 'any' ? 'any' : lower;
    if (state.mode === 'sold') {
      await startSearch(jid, state);
      return;
    }
    state.stage = 'ask_beds';
    await sendText(jid, store.renderText('askBeds'));
    return;
  }

  if (state.stage === 'ask_beds') {
    const beds = parseInt(text, 10);
    state.minBeds = lower === 'any' || Number.isNaN(beds) ? 'any' : beds;
    if (b.askBudget) {
      state.stage = 'ask_budget';
      await sendText(jid, store.renderText('askBudget'));
      return;
    }
    await startSearch(jid, state);
    return;
  }

  if (state.stage === 'ask_budget') {
    const budget = parseInt(String(text).replace(/[^\d]/g, ''), 10);
    state.maxPrice = lower === 'any' || Number.isNaN(budget) ? 'any' : budget;
    await startSearch(jid, state);
    return;
  }

  // --- no match --------------------------------------------------------
  if (state.stage === 'no_match') {
    if (text === '1') {
      softReset(state);
      state.stage = 'main';
      await sendText(jid, store.renderText('welcome', { menu: menuBlock() }));
      return;
    }
    if (text === '2') {
      await requestAgent(jid, state, 'no listings matched their search');
      softReset(state);
      return;
    }
    await sendText(jid, store.renderText('noMatch'));
    return;
  }

  // --- results ---------------------------------------------------------
  if (state.stage === 'results') {
    if (keywordList(b.moreKeywords).includes(lower)) {
      state.pageStart += state.shownIds.length;
      await sendResultPage(jid, state);
      return;
    }
    if (lower === 'sell') {
      state.stage = 'sell_type';
      await sendText(jid, store.renderText('askSellType'));
      return;
    }
    const pick = parseInt(text, 10);
    if (pick >= 1 && pick <= state.shownIds.length) {
      const listing = listingById(state.shownIds[pick - 1]);
      if (!listing) {
        await sendText(jid, store.renderText('backToResults'));
        return;
      }
      state.selectedId = listing.id;
      state.stage = 'property_action';
      const key = listing.status === 'sold' ? 'soldPropertyActions' : 'propertyActions';
      await sendText(
        jid,
        store.renderText(key, { title: listing.title || listing.address, price: store.formatPrice(listing) })
      );
      return;
    }
    await sendText(jid, store.renderText('backToResults'));
    return;
  }

  // --- property action -------------------------------------------------
  if (state.stage === 'property_action') {
    const listing = listingById(state.selectedId);
    if (!listing) {
      state.stage = 'results';
      await sendText(jid, store.renderText('backToResults'));
      return;
    }
    if (text === '2') {
      state.stage = 'results';
      await sendText(jid, store.renderText('backToResults'));
      return;
    }
    if (text === '3') {
      softReset(state);
      state.stage = 'main';
      await sendText(jid, store.renderText('welcome', { menu: menuBlock() }));
      return;
    }
    if (text === '1') {
      if (listing.status === 'sold') {
        state.stage = 'sell_type';
        await sendText(jid, store.renderText('askSellType'));
        return;
      }
      if (!state.shortlist.includes(listing.id)) state.shortlist.push(listing.id);
      state.stage = 'post_shortlist';
      await sendText(
        jid,
        store.renderText('shortlistAdded', {
          title: listing.title || listing.address,
          count: state.shortlist.length,
        })
      );
      return;
    }
    const key = listing.status === 'sold' ? 'soldPropertyActions' : 'propertyActions';
    await sendText(jid, store.renderText(key, { title: listing.title || listing.address, price: store.formatPrice(listing) }));
    return;
  }

  // --- after shortlisting ---------------------------------------------
  if (state.stage === 'post_shortlist') {
    if (text === '1') {
      state.stage = 'results';
      await sendText(jid, store.renderText('backToResults'));
      return;
    }
    if (text === '2') {
      state.stage = 'visit_name';
      await sendText(jid, store.renderText('askVisitName'));
      return;
    }
    if (text === '3') {
      softReset(state);
      state.stage = 'main';
      await sendText(jid, store.renderText('welcome', { menu: menuBlock() }));
      return;
    }
    await sendText(jid, 'Please reply 1, 2 or 3.');
    return;
  }

  // --- book a visit ----------------------------------------------------
  if (state.stage === 'visit_name') {
    state.contactName = text;
    state.stage = 'visit_phone';
    await sendText(jid, store.renderText('askVisitPhone'));
    return;
  }
  if (state.stage === 'visit_phone') {
    if (!isValidPhone(text)) {
      await sendText(jid, store.renderText('invalidPhone'));
      return;
    }
    state.contactPhone = text;
    state.stage = 'visit_time';
    await sendText(jid, store.renderText('askVisitTime'));
    return;
  }
  if (state.stage === 'visit_time') {
    state.preferredTime = text;
    await finaliseVisit(jid, state);
    return;
  }

  // --- sell / appraisal ------------------------------------------------
  if (state.stage === 'sell_type') {
    state.sell = { ...state.sell, type: text };
    state.stage = 'sell_location';
    await sendText(jid, store.renderText('askSellLocation'));
    return;
  }
  if (state.stage === 'sell_location') {
    state.sell.location = text;
    state.stage = 'sell_price';
    await sendText(jid, store.renderText('askSellPrice'));
    return;
  }
  if (state.stage === 'sell_price') {
    state.sell.price = text;
    state.stage = 'sell_name';
    await sendText(jid, store.renderText('askSellName'));
    return;
  }
  if (state.stage === 'sell_name') {
    state.sell.name = text;
    state.stage = 'sell_phone';
    await sendText(jid, store.renderText('askSellPhone'));
    return;
  }
  if (state.stage === 'sell_phone') {
    if (!isValidPhone(text)) {
      await sendText(jid, store.renderText('invalidPhone'));
      return;
    }
    await finaliseSeller(jid, state, text);
    return;
  }

  await sendText(jid, store.renderText('fallback'));
}

/* ------------------------------------------------------------------ *
 * per-chat lock — one message at a time per customer
 * ------------------------------------------------------------------ */

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

async function onMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (msg.key.fromMe) return;
  if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  if (jid.endsWith('@g.us') && !store.getSettings().behavior.replyToGroups) return;

  const id = msg.key.id;
  if (id) {
    if (processedIds.has(id)) return; // already answered, e.g. before a restart
    processedIds.add(id);
    if (processedIds.size > 1200) {
      const first = processedIds.values().next().value;
      processedIds.delete(first);
    }
  }

  const text = extractText(msg).trim();
  if (!text) return;

  store.bumpStat('messagesIn');
  store.touchCustomer(jid, { pushName: msg.pushName, senderPn: msg.key.senderPn || msg.key.participantPn });
  log('chat', `${msg.pushName || jid}: ${text.slice(0, 120)}`);

  if (store.getSettings().behavior.sendReadReceipts) {
    await runtime.sock?.readMessages([msg.key]).catch(() => {});
  }

  if (!store.getSettings().behavior.autoReplyEnabled) {
    await sendText(jid, store.renderText('autoReplyOff'));
    persistSoon();
    return;
  }

  const state = getState(jid);
  try {
    await handleText(jid, text, state);
  } catch (err) {
    log('error', `Flow error for ${jid}: ${err.message}`);
    await sendText(jid, store.renderText('errorNote'));
    softReset(state);
  }
  state.updatedAt = new Date().toISOString();
  persistSoon();
}

/* ------------------------------------------------------------------ *
 * connection lifecycle
 * ------------------------------------------------------------------ */

function detachSocket() {
  if (!runtime.sock) return;
  try {
    runtime.sock.ev.removeAllListeners();
  } catch { /* ignore */ }
  try {
    runtime.sock.end(undefined);
  } catch { /* ignore */ }
  runtime.sock = null;
}

async function start() {
  if (runtime.busy) return { ok: false, message: 'Already starting, give it a second.' };
  if (isConnected()) return { ok: true, message: 'Already connected.' };

  runtime.busy = true;
  runtime.manualStop = false;
  runtime.lastError = null;
  runtime.status = 'starting';
  log('info', 'Starting WhatsApp connection…');

  try {
    detachSocket();
    const { state: authState, saveCreds } = await useMultiFileAuthState(store.PATHS.auth);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      log('warn', 'Could not fetch the latest WhatsApp version, using the bundled default.');
    }

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false, // let the agent's phone keep getting notifications
      syncFullHistory: false,
      browser: ['AlNoorRealEstate', 'Chrome', '120.0.0'],
    });
    runtime.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        runtime.status = 'qr';
        runtime.qrGeneratedAt = new Date().toISOString();
        try {
          runtime.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          log('info', 'New QR code ready — open Dashboard > Connection to scan it.');
        } catch (err) {
          log('error', `Could not render the QR code: ${err.message}`);
        }
      }

      if (connection === 'open') {
        runtime.status = 'connected';
        runtime.qrDataUrl = null;
        runtime.connectedAt = new Date().toISOString();
        runtime.reconnectAttempts = 0;
        runtime.me = { id: sock.user?.id || null, name: sock.user?.name || sock.user?.verifiedName || null };
        adminJidCache = null;
        log('info', `Connected as ${runtime.me.name || runtime.me.id}`);
        void resolveAdminJid();
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'connection closed';
        runtime.qrDataUrl = null;

        if (runtime.manualStop) {
          runtime.status = 'stopped';
          log('info', 'Bot stopped.');
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          runtime.status = 'stopped';
          runtime.lastError = 'Logged out from the phone. Scan a new QR to reconnect.';
          store.clearSession();
          log('warn', runtime.lastError);
          return;
        }

        runtime.reconnectAttempts += 1;
        runtime.status = 'reconnecting';
        runtime.lastError = `${reason}${code ? ` (code ${code})` : ''}`;
        const backoff = Math.min(60000, 3000 * runtime.reconnectAttempts);
        log('warn', `Disconnected: ${runtime.lastError}. Reconnecting in ${Math.round(backoff / 1000)}s (attempt ${runtime.reconnectAttempts}).`);
        setTimeout(() => {
          if (!runtime.manualStop) void start();
        }, backoff).unref?.();
      }
    });

    sock.ev.on('messages.upsert', async (upsert) => {
      // "notify" = a live message. "append"/history replay must be ignored or
      // the bot answers weeks-old chats every time it reconnects.
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages || []) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        void withChatLock(jid, () => onMessage(msg));
      }
    });

    return { ok: true, message: 'Connecting. Watch Connection for the QR code.' };
  } catch (err) {
    runtime.status = 'stopped';
    runtime.lastError = err.message;
    log('error', `Start failed: ${err.message}`);
    return { ok: false, message: err.message };
  } finally {
    runtime.busy = false;
  }
}

async function stop() {
  runtime.manualStop = true;
  detachSocket();
  runtime.status = 'stopped';
  runtime.qrDataUrl = null;
  runtime.me = null;
  runtime.connectedAt = null;
  log('info', 'Bot stopped by the dashboard.');
  return { ok: true, message: 'Bot stopped.' };
}

async function logout() {
  runtime.manualStop = true;
  try {
    if (runtime.sock) await runtime.sock.logout();
  } catch (err) {
    log('warn', `Logout call failed (clearing the session anyway): ${err.message}`);
  }
  detachSocket();
  const removed = store.clearSession();
  runtime.status = 'stopped';
  runtime.qrDataUrl = null;
  runtime.me = null;
  runtime.connectedAt = null;
  adminJidCache = null;
  log('info', `Logged out and cleared ${removed} session file(s). Press Connect for a fresh QR.`);
  return { ok: true, message: 'Logged out. Press Connect to scan a new QR.' };
}

/**
 * Manual reply from the dashboard. Accepts a stored JID (used as-is) or a bare
 * number typed by the agent (only then do we build a JID).
 */
async function sendManual(target, text) {
  if (!isConnected()) return { ok: false, message: 'Bot is not connected.' };
  const jid = jidFromNumber(target);
  if (!jid) return { ok: false, message: 'That does not look like a number or a chat ID.' };
  if (!String(text || '').trim()) return { ok: false, message: 'Message is empty.' };

  const result = await enqueueSend(jid, { text: String(text).trim() }, { raw: true });
  if (!result.ok) return { ok: false, message: result.error || 'Send failed.' };

  store.bumpStat('manualReplies');
  store.saveInteraction(jid, { kind: 'manual_reply', text: String(text).trim() });
  log('info', `Manual reply sent to ${jid}`);
  return { ok: true, message: 'Message sent.' };
}

function shutdown() {
  try {
    const ids = Array.from(processedIds);
    store.saveConversations({ chats: Object.fromEntries(chats), processedIds: ids.slice(-800) });
    store.flushStats();
  } catch { /* ignore */ }
}

hydrate();

module.exports = {
  start,
  stop,
  logout,
  getStatus,
  getLogs,
  isConnected,
  sendManual,
  shutdown,
  // exported for the self test
  _internals: {
    handleText,
    getState,
    blankState,
    chats,
    propertyCaption,
    menuBlock,
    extractText,
    isAfterHours,
    runtime, // selftest.js injects a fake socket here; nothing else touches it
  },
};