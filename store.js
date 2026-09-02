'use strict';
/**
 * store.js — the single source of truth for everything the bot and dashboard share.
 *
 * Everything is plain JSON on disk under DATA_DIR so the dashboard can edit it
 * with no database to provision. Writes are atomic (tmp file + rename) so a
 * crash mid-write can never leave a half-written listings.json behind.
 *
 *   DATA_DIR/
 *     settings.json        <- admin number, rate limits, every bot reply text
 *     listings.json        <- current + sold properties (dashboard CRUD)
 *     stats.json           <- message + lead counters, per-day history
 *     conversations.json   <- live chat state, survives a restart
 *     customers/<jid>.json <- one file per customer, all their interactions
 *     auth_session/        <- Baileys credentials
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const PATHS = {
  root: DATA_DIR,
  auth: path.join(DATA_DIR, 'auth_session'),
  customers: path.join(DATA_DIR, 'customers'),
  settings: path.join(DATA_DIR, 'settings.json'),
  listings: path.join(DATA_DIR, 'listings.json'),
  stats: path.join(DATA_DIR, 'stats.json'),
  conversations: path.join(DATA_DIR, 'conversations.json'),
};

for (const dir of [PATHS.root, PATHS.auth, PATHS.customers]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ *
 * low level read / write
 * ------------------------------------------------------------------ */

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
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * settings — every knob the dashboard can turn
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  business: {
    name: 'Al-Noor Real Estate',
    tagline: 'Central Coast property specialists',
    currencySymbol: '$',
    numberLocale: 'en-AU',
  },
  admin: {
    // Bare digits, country code, no + and no spaces. Resolved to a real JID at
    // connect time via sock.onWhatsApp() — never trusted as a raw JID string.
    number: '',
    notifyVisitRequest: true,
    notifySellerLead: true,
    notifyAgentRequest: true,
    agentRequestCooldownMinutes: 10,
  },
  behavior: {
    maxCardsShown: 3,
    sendImages: true,
    sendReadReceipts: true,
    showTypingIndicator: true,
    askBudget: false,
    replyToGroups: false,
    // Comma separated. Matched on the whole message, lowercased.
    resetKeywords: 'menu, /menu, start, /start, restart',
    greetKeywords: 'hi, hello, hey, salam, assalam o alaikum, aoa',
    agentKeywords: 'agent, /agent, human, talk to someone',
    shortlistKeywords: 'shortlist, /shortlist, my list',
    moreKeywords: 'more, next',
    // Master switch. Off = bot stays connected but answers nobody.
    autoReplyEnabled: true,
    // Off hours: bot still replies but appends the after-hours note.
    afterHoursEnabled: false,
    afterHoursFrom: '19:00',
    afterHoursTo: '08:00',
  },
  rate: {
    perMinuteLimit: 12,
    minDelayMs: 1500,
    maxDelayMs: 4000,
    typingMinMs: 700,
    typingMaxMs: 1800,
    addRandomEmoji: false,
  },
  // Every string the bot can say. {{placeholders}} are filled at send time.
  texts: {
    welcome:
      '🏠 *Welcome to {{business}}!*\n\nWhat would you like to do?\n\n{{menu}}\n\n_Reply with a number_',
    menuItem1: 'Browse current listings',
    menuItem2: 'See recently sold properties',
    menuItem3: 'Sell / list my property',
    menuItem4: 'Talk to an agent',
    invalidMenu: "Sorry, I didn't catch that. Please reply with a number 1-4.",
    askSuburbCurrent:
      'Which suburb are you interested in? (for example "Springfield" or "Terrigal") — or type *any*',
    askSuburbSold: 'Which suburb? — or type *any* to see all recent sales',
    askBeds: 'How many bedrooms minimum? (for example 3) — or type *any*',
    askBudget: "What's your maximum budget? (for example 900000) — or type *any*",
    resultsHeader: "Here's what matches your search ({{shown}} of {{total}}):",
    resultsHeaderWidened:
      "I couldn't find that exact suburb, so here's what matches your other filters ({{shown}} of {{total}}):",
    resultsFooter:
      'Reply with a number to see options for that property{{more}}, or *menu* for a new search.',
    soldHeader: "Here's what we've recently sold ({{shown}} of {{total}}):",
    soldFooter:
      'Want a result like this for your own property? Reply *sell*. Or reply with a number for details{{more}}.',
    noMatch:
      'No listings match that right now.\n\n*1️⃣ Try different filters*\n*2️⃣ Talk to an agent*',
    noMoreResults: "That's everything I have for this search. Reply *menu* to start a new one.",
    propertyActions:
      'What would you like to do with *{{title}}*?\n\n*1️⃣ Add to my shortlist*\n*2️⃣ Back to results*\n*3️⃣ New search*',
    soldPropertyActions:
      '*{{title}}* sold for {{price}}.\n\n*1️⃣ Get a free appraisal for my property*\n*2️⃣ Back to results*\n*3️⃣ New search*',
    shortlistAdded:
      '✅ Added to your shortlist: {{title}}\n\nShortlisted so far: {{count}}\n\n*1️⃣ Browse more results*\n*2️⃣ Book a visit*\n*3️⃣ New search*',
    shortlistEmpty: 'Your shortlist is empty. Reply *menu* to start browsing.',
    backToResults: 'Reply with another number from the list above, or *menu* for a new search.',
    newSearchPrompt: 'Reply *menu* to start a new search.',
    askVisitName: "To book a visit, what's your name?",
    askVisitPhone: 'Best contact number?',
    askVisitTime: 'What day and time suits you for a visit?',
    visitDone:
      '✅ *Visit request received!*\n\nReference: {{ref}}\nName: {{name}}\nPhone: {{phone}}\nPreferred time: {{time}}\n\n{{count}} property(ies) shortlisted.\n\nOur team will call to confirm.\n\n_Reply *menu* for a new search_',
    askSellType: 'Great — what type of property is it? (House, Apartment, Land...)',
    askSellLocation: 'Where is it located? (suburb or area)',
    askSellPrice: "What's your expected price? (or type *not sure*)",
    askSellName: "What's your name?",
    askSellPhone: 'Best contact number?',
    sellDone:
      "✅ Thanks {{name}}! We've got your details.\n\nReference: {{ref}}\n\nOur team will contact you shortly to arrange a free appraisal.\n\n_Reply *menu* for anything else_",
    invalidPhone:
      "That doesn't look like a phone number. Please send digits only (7 to 15 digits).",
    agentNotified:
      "A member of our team has been notified and will message you here shortly. Reply *menu* any time to go back to the bot.",
    agentAlreadyNotified:
      "You're already in the queue — our team will be with you shortly. Reply *menu* to keep browsing meanwhile.",
    afterHoursNote: "\n\n_Our office is closed right now, we'll reply first thing in the morning._",
    fallback: 'Reply *menu* to get started, or *agent* to talk to a human.',
    errorNote: 'Something went wrong on my end. Reply *menu* to start again.',
    autoReplyOff:
      "Thanks for your message — our team will get back to you personally very soon.",
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
    // Persist so the file on disk always shows the full shape (easier to eyeball).
    if (!fs.existsSync(PATHS.settings)) writeJson(PATHS.settings, settingsCache);
  }
  return settingsCache;
}

function saveSettings(patch) {
  settingsCache = deepMerge(getSettings(), patch || {});
  writeJson(PATHS.settings, settingsCache);
  return settingsCache;
}

function resetTexts() {
  return saveSettings({ texts: DEFAULT_SETTINGS.texts });
}

/**
 * Fill {{placeholders}} and drop unknown ones rather than printing them raw.
 */
function renderText(key, vars = {}) {
  const settings = getSettings();
  const template = settings.texts[key] != null ? settings.texts[key] : DEFAULT_SETTINGS.texts[key];
  if (template == null) return '';
  const all = { business: settings.business.name, ...vars };
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, name) =>
    all[name] == null ? '' : String(all[name])
  );
}

/* ------------------------------------------------------------------ *
 * listings
 * ------------------------------------------------------------------ */

const LISTING_FIELDS = [
  'refId', 'status', 'active', 'title', 'address', 'suburb',
  'priceDisplay', 'priceNumeric', 'bedrooms', 'bathrooms', 'parking',
  'landSize', 'description', 'heroImageUrl', 'agent', 'soldDate',
];

function toIntOrNull(value) {
  if (value === '' || value == null) return null;
  const n = parseInt(String(value).replace(/[^\d-]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

function normaliseListing(input, existing = {}) {
  const out = { ...existing };
  out.id = existing.id || newId('lst');
  out.refId = String(input.refId ?? existing.refId ?? '').trim();
  out.status = input.status === 'sold' ? 'sold' : 'current';
  out.active = input.active === undefined ? existing.active !== false : Boolean(input.active);
  out.title = String(input.title ?? existing.title ?? '').trim();
  out.address = String(input.address ?? existing.address ?? '').trim();
  out.suburb = String(input.suburb ?? existing.suburb ?? '').trim();
  out.priceDisplay = String(input.priceDisplay ?? existing.priceDisplay ?? '').trim();
  out.priceNumeric = input.priceNumeric === undefined ? existing.priceNumeric ?? null : toIntOrNull(input.priceNumeric);
  out.bedrooms = input.bedrooms === undefined ? existing.bedrooms ?? null : toIntOrNull(input.bedrooms);
  out.bathrooms = input.bathrooms === undefined ? existing.bathrooms ?? null : toIntOrNull(input.bathrooms);
  out.parking = input.parking === undefined ? existing.parking ?? null : toIntOrNull(input.parking);
  out.landSize = String(input.landSize ?? existing.landSize ?? '').trim();
  // Units and townhouses come out of the CRM with a land size of "0 m²". Showing
  // that to a customer reads like a broken record, so treat zero as "no land figure".
  if (/^0\s*(m2|m²|sqm)?$/i.test(out.landSize)) out.landSize = '';
  out.description = String(input.description ?? existing.description ?? '').trim();
  out.heroImageUrl = String(input.heroImageUrl ?? existing.heroImageUrl ?? '').trim();
  out.agent = String(input.agent ?? existing.agent ?? '').trim();
  out.soldDate = String(input.soldDate ?? existing.soldDate ?? '').trim();
  // A CRM export usually carries only the advertised price ("$849,000 - $899,000").
  // Without a plain number to compare against, a buyer's budget would quietly
  // exclude every imported listing, so read the first figure out of the text.
  if (out.priceNumeric == null && out.priceDisplay) {
    const firstFigure = out.priceDisplay.match(/\d[\d,. ]*/);
    if (firstFigure) out.priceNumeric = toIntOrNull(firstFigure[0]);
  }
  out.updatedAt = new Date().toISOString();
  if (!out.createdAt) out.createdAt = out.updatedAt;
  return out;
}

/**
 * First boot: if there's no listings.json yet but the old properties_data.js is
 * sitting next to us, import it once so nothing has to be retyped.
 */
function seedListingsFromLegacyFile() {
  try {
    const legacyPath = path.join(__dirname, 'properties_data.js');
    if (!fs.existsSync(legacyPath)) return [];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const legacy = require(legacyPath);
    const current = (legacy.CURRENT_LISTINGS || []).map((p) =>
      normaliseListing({ ...p, refId: p.id, status: 'current' }, {})
    );
    const sold = (legacy.SOLD_LISTINGS || []).map((p) =>
      normaliseListing({ ...p, refId: p.id, status: 'sold' }, {})
    );
    const all = [...current, ...sold];
    if (all.length) console.log(`[store] seeded ${all.length} listings from properties_data.js`);
    return all;
  } catch (err) {
    console.error(`[store] legacy seed failed: ${err.message}`);
    return [];
  }
}

let listingsCache = null;

function getListings() {
  if (!listingsCache) {
    let saved = readJson(PATHS.listings, null);
    if (!Array.isArray(saved)) {
      saved = seedListingsFromLegacyFile();
      writeJson(PATHS.listings, saved);
    }
    listingsCache = saved;
  }
  return listingsCache;
}

function persistListings() {
  writeJson(PATHS.listings, listingsCache);
  return listingsCache;
}

function addListing(input) {
  const listing = normaliseListing(input, {});
  getListings().push(listing);
  persistListings();
  return listing;
}

function updateListing(id, input) {
  const all = getListings();
  const index = all.findIndex((l) => l.id === id);
  if (index === -1) return null;
  all[index] = normaliseListing(input, all[index]);
  persistListings();
  return all[index];
}

function deleteListing(id) {
  const all = getListings();
  const index = all.findIndex((l) => l.id === id);
  if (index === -1) return false;
  all.splice(index, 1);
  persistListings();
  return true;
}

function replaceListings(rows) {
  listingsCache = rows.map((r) => normaliseListing(r, {}));
  persistListings();
  return listingsCache;
}

function importListings(rows, { status = 'current', replaceExisting = false } = {}) {
  const incoming = rows.map((r) => normaliseListing({ status, ...r }, {}));
  if (replaceExisting) {
    // Only wipe the status being imported, leave the other half alone.
    listingsCache = getListings().filter((l) => l.status !== status).concat(incoming);
  } else {
    const all = getListings();
    for (const row of incoming) {
      const match = row.refId
        ? all.find((l) => l.refId === row.refId && l.status === row.status)
        : all.find((l) => l.address.toLowerCase() === row.address.toLowerCase() && l.status === row.status);
      if (match) Object.assign(match, normaliseListing(row, match));
      else all.push(row);
    }
    listingsCache = all;
  }
  persistListings();
  return incoming.length;
}

function formatPrice(listing) {
  const { currencySymbol, numberLocale } = getSettings().business;
  if (listing.priceDisplay) return listing.priceDisplay;
  if (listing.priceNumeric) return `${currencySymbol}${listing.priceNumeric.toLocaleString(numberLocale)}`;
  return 'Contact agent';
}

function searchListings({ status = 'current', suburb = 'any', minBeds = 'any', maxPrice = 'any' } = {}) {
  const needle = String(suburb || 'any').trim().toLowerCase();
  return getListings().filter((l) => {
    if (l.status !== status) return false;
    if (l.active === false) return false;
    if (needle !== 'any') {
      const haystack = `${l.suburb} ${l.address}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (minBeds !== 'any' && !(l.bedrooms !== null && l.bedrooms >= Number(minBeds))) return false;
    if (maxPrice !== 'any' && l.priceNumeric && l.priceNumeric > Number(maxPrice)) return false;
    return true;
  });
}

/**
 * Things a human should look at — surfaced on the dashboard overview.
 * The v3 data had 7 Bilkurra Place in both CURRENT and SOLD, which made the
 * bot advertise a sold house as available. This is how you catch that.
 */
function dataWarnings() {
  const warnings = [];
  const all = getListings();
  const byAddress = new Map();
  for (const l of all) {
    const key = l.address.trim().toLowerCase();
    if (!key) continue;
    if (!byAddress.has(key)) byAddress.set(key, []);
    byAddress.get(key).push(l);
  }
  for (const [, group] of byAddress) {
    const statuses = new Set(group.map((l) => l.status));
    if (statuses.size > 1) {
      warnings.push({
        level: 'warn',
        message: `"${group[0].address}" is listed as both current and sold. Buyers will be shown a property that is gone — archive the current one.`,
      });
    } else if (group.length > 1) {
      warnings.push({
        level: 'info',
        message: `"${group[0].address}" appears ${group.length} times as ${group[0].status}.`,
      });
    }
  }
  for (const l of all) {
    if (l.active === false) continue;
    if (!l.heroImageUrl) {
      warnings.push({ level: 'info', message: `"${l.title || l.address}" has no photo — it will be sent as text only.` });
    }
  }
  if (!getSettings().admin.number) {
    warnings.push({ level: 'warn', message: 'No admin WhatsApp number set, so nobody is being notified about new leads. Settings > Lead notifications.' });
  }
  return warnings;
}

/* ------------------------------------------------------------------ *
 * customers + leads (one file per customer, keyed by the raw JID)
 * ------------------------------------------------------------------ */

function customerFile(jid) {
  return path.join(PATHS.customers, `${String(jid).replace(/[^a-zA-Z0-9]/g, '_')}.json`);
}

function getCustomer(jid) {
  return readJson(customerFile(jid), {
    jid,
    phone: null,
    name: null,
    pushName: null,
    tags: [],
    notes: '',
    firstSeen: null,
    lastSeen: null,
    interactions: [],
  });
}

function saveCustomer(record) {
  writeJson(customerFile(record.jid), record);
  return record;
}

function touchCustomer(jid, { pushName, senderPn } = {}) {
  const record = getCustomer(jid);
  const now = new Date().toISOString();
  if (!record.firstSeen) record.firstSeen = now;
  record.lastSeen = now;
  if (pushName) record.pushName = pushName;
  if (senderPn && !record.phone) record.phone = String(senderPn).split('@')[0];
  return saveCustomer(record);
}

function saveInteraction(jid, interaction) {
  const record = getCustomer(jid);
  const now = new Date().toISOString();
  if (!record.firstSeen) record.firstSeen = now;
  record.lastSeen = now;
  if (interaction.contactName) record.name = interaction.contactName;
  if (interaction.contactPhone) record.phone = interaction.contactPhone;
  record.interactions.push({ id: newId('int'), timestamp: now, ...interaction });
  saveCustomer(record);
  bumpStat(`lead.${interaction.kind}`);
  return record;
}

function listCustomers() {
  if (!fs.existsSync(PATHS.customers)) return [];
  return fs
    .readdirSync(PATHS.customers)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(PATHS.customers, f), null))
    .filter(Boolean)
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}

function deleteCustomer(jid) {
  const file = customerFile(jid);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/* ------------------------------------------------------------------ *
 * stats
 * ------------------------------------------------------------------ */

const EMPTY_STATS = {
  messagesIn: 0,
  messagesOut: 0,
  imagesOut: 0,
  sendFailures: 0,
  manualReplies: 0,
  'lead.visit_request': 0,
  'lead.sell_lead': 0,
  'lead.agent_request': 0,
  byDay: {},
  firstBootAt: null,
};

let statsCache = null;
let statsDirty = false;

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
  if (!stats.byDay[day]) stats.byDay[day] = { in: 0, out: 0, leads: 0 };
  if (key === 'messagesIn') stats.byDay[day].in += amount;
  if (key === 'messagesOut') stats.byDay[day].out += amount;
  if (key.startsWith('lead.')) stats.byDay[day].leads += amount;
  // keep 60 days of history, no more
  const days = Object.keys(stats.byDay).sort();
  while (days.length > 60) delete stats.byDay[days.shift()];
  statsDirty = true;
  scheduleStatsFlush();
  return stats;
}

// Counters are held in memory so a busy chat isn't writing a file per message,
// but a container can be killed at any moment, so never hold them for long.
let statsFlushTimer = null;

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
  statsDirty = false;
}

function lastNDays(n = 14) {
  const stats = getStats();
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    out.push({ day: key, ...(stats.byDay[key] || { in: 0, out: 0, leads: 0 }) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * conversation state (so a restart doesn't drop people mid-flow)
 * ------------------------------------------------------------------ */

function loadConversations() {
  return readJson(PATHS.conversations, { chats: {}, processedIds: [] });
}

function saveConversations(data) {
  writeJson(PATHS.conversations, data);
}

/* ------------------------------------------------------------------ *
 * WhatsApp session backup / restore — the answer to Render's ephemeral disk
 * ------------------------------------------------------------------ */

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
  getSettings,
  saveSettings,
  resetTexts,
  renderText,
  getListings,
  addListing,
  updateListing,
  deleteListing,
  replaceListings,
  importListings,
  searchListings,
  formatPrice,
  dataWarnings,
  getCustomer,
  saveCustomer,
  touchCustomer,
  saveInteraction,
  listCustomers,
  deleteCustomer,
  getStats,
  bumpStat,
  flushStats,
  lastNDays,
  loadConversations,
  saveConversations,
  backupSession,
  restoreSession,
  clearSession,
};