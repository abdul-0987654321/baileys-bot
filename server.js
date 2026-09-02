'use strict';
/**
 * server.js — one process: the HTML dashboard, its API, and the WhatsApp bot.
 *
 * Render only exposes a single port per service, so the bot lives inside the
 * same process as the web server. The dashboard drives it over /api/bot/*.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

/**
 * Load .env by hand, and do it BEFORE requiring store.js — store reads DATA_DIR
 * the moment it is imported, so anything later is too late.
 *
 * No dotenv dependency and no reliance on `node --env-file`: that flag only exists
 * on newer Node, and both `npm start` and Render's start command are plain
 * `node server.js`. A real environment variable always beats the file, which is
 * what lets Render's own Environment settings override whatever is in here.
 */
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

/* ------------------------------------------------------------------ *
 * auth — signed cookie, no database needed
 * ------------------------------------------------------------------ */

let PASSWORD = process.env.DASHBOARD_PASSWORD;
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(4).toString('hex');
  console.log('\n' + '='.repeat(64));
  console.log('  DASHBOARD_PASSWORD is not set, so I generated a temporary one:');
  console.log(`      ${PASSWORD}`);
  console.log('  Set DASHBOARD_PASSWORD in your environment to keep it stable.');
  console.log('='.repeat(64) + '\n');
}

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'anre_session';
const SESSION_DAYS = 7;

function signToken() {
  const body = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400000 })
  ).toString('base64url');
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
  } catch {
    return false;
  }
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
  if (entry.count >= 6) {
    entry.until = Date.now() + 5 * 60000;
    entry.count = 0;
  }
  loginAttempts.set(ip, entry);
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginBlocked(ip)) {
    return res.status(429).json({ ok: false, message: 'Too many attempts. Try again in 5 minutes.' });
  }
  const supplied = String(req.body?.password || '');
  const ok =
    supplied.length === PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(PASSWORD));
  if (!ok) {
    noteFailedLogin(ip);
    return res.status(401).json({ ok: false, message: 'Wrong password.' });
  }
  loginAttempts.delete(ip);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${signToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`
  );
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, bot: bot.getStatus().status, uptimeSeconds: Math.round(process.uptime()) });
});

// Everything else under /api needs a valid cookie.
app.use('/api', (req, res, next) => {
  if (verifyToken(parseCookies(req)[COOKIE])) return next();
  return res.status(401).json({ ok: false, message: 'Not signed in.' });
});

app.get('/api/session', (req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------ *
 * overview
 * ------------------------------------------------------------------ */

app.get('/api/overview', (req, res) => {
  const customers = store.listCustomers();
  const listings = store.getListings();
  const stats = store.getStats();

  const interactions = customers.flatMap((c) =>
    c.interactions.map((i) => ({ ...i, jid: c.jid, customerName: c.name || c.pushName || null }))
  );
  const count = (kind) => interactions.filter((i) => i.kind === kind).length;

  res.json({
    ok: true,
    bot: bot.getStatus(),
    stats: {
      currentListings: listings.filter((l) => l.status === 'current' && l.active !== false).length,
      soldListings: listings.filter((l) => l.status === 'sold' && l.active !== false).length,
      archivedListings: listings.filter((l) => l.active === false).length,
      customers: customers.length,
      interactions: interactions.length,
      visitRequests: count('visit_request'),
      sellerLeads: count('sell_lead'),
      agentRequests: count('agent_request'),
      manualReplies: count('manual_reply'),
      messagesIn: stats.messagesIn || 0,
      messagesOut: stats.messagesOut || 0,
      imagesOut: stats.imagesOut || 0,
      sendFailures: stats.sendFailures || 0,
      firstBootAt: stats.firstBootAt,
    },
    trend: store.lastNDays(14),
    warnings: store.dataWarnings(),
    recent: interactions
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, 12),
    dataDir: store.DATA_DIR,
    serverUptimeSeconds: Math.round(process.uptime()),
  });
});

/* ------------------------------------------------------------------ *
 * listings
 * ------------------------------------------------------------------ */

app.get('/api/listings', (req, res) => res.json({ ok: true, listings: store.getListings() }));

app.post('/api/listings', (req, res) => {
  const listing = store.addListing(req.body || {});
  res.json({ ok: true, listing });
});

app.put('/api/listings/:id', (req, res) => {
  const listing = store.updateListing(req.params.id, req.body || {});
  if (!listing) return res.status(404).json({ ok: false, message: 'No listing with that id.' });
  res.json({ ok: true, listing });
});

app.delete('/api/listings/:id', (req, res) => {
  const removed = store.deleteListing(req.params.id);
  if (!removed) return res.status(404).json({ ok: false, message: 'No listing with that id.' });
  res.json({ ok: true });
});

/* --- CSV import ---------------------------------------------------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

const HEADER_ALIASES = {
  refId: ['id', 'listingid', 'mlsid', 'ref', 'reference', 'propertyid'],
  title: ['title', 'heading', 'headline', 'name', 'adheading'],
  address: ['address', 'fulladdress', 'streetaddress', 'propertyaddress', 'addressfull'],
  suburb: ['suburb', 'locality', 'city', 'town'],
  priceDisplay: ['price', 'pricedisplay', 'displayprice', 'pricetext', 'advertisedprice', 'priceadvertised'],
  priceNumeric: ['pricenumeric', 'saleprice', 'soldprice', 'searchprice', 'pricefrom', 'amount'],
  bedrooms: ['bedrooms', 'beds', 'bed', 'attrbedrooms'],
  bathrooms: ['bathrooms', 'baths', 'bath', 'attrbathrooms'],
  parking: ['parking', 'cars', 'carspaces', 'garages', 'attrgarages'],
  landSize: ['landsize', 'land', 'landarea', 'attrlandarea'],
  description: ['description', 'details', 'adtext', 'body', 'comments'],
  heroImageUrl: ['heroimageurl', 'image', 'imageurl', 'photo', 'mainimage', 'heroimage', 'images'],
  agent: ['agent', 'agents', 'listingagent', 'agentname'],
  soldDate: ['solddate', 'datesold', 'settlementdate', 'contractdate'],
};

function normaliseHeader(h) {
  return String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapHeaders(headerRow) {
  const mapping = {};
  const unmapped = [];
  headerRow.forEach((raw, index) => {
    const key = normaliseHeader(raw);
    const field = Object.keys(HEADER_ALIASES).find(
      (f) => normaliseHeader(f) === key || HEADER_ALIASES[f].includes(key)
    );
    if (field) mapping[field] = index;
    else if (String(raw).trim()) unmapped.push(String(raw).trim());
  });
  return { mapping, unmapped };
}

app.post('/api/listings/import', (req, res) => {
  const { csv, status = 'current', replaceExisting = false } = req.body || {};
  if (!csv || typeof csv !== 'string') {
    return res.status(400).json({ ok: false, message: 'Paste the CSV text in the "csv" field.' });
  }
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    return res.status(400).json({ ok: false, message: 'That CSV has a header but no rows.' });
  }
  const { mapping, unmapped } = mapHeaders(rows[0]);
  if (mapping.address === undefined && mapping.title === undefined) {
    return res.status(400).json({
      ok: false,
      message: 'I could not find an address or title column. Rename a column to "Address" and try again.',
      unmapped,
    });
  }
  const records = rows.slice(1).map((row) => {
    const out = {};
    for (const [field, index] of Object.entries(mapping)) out[field] = row[index];
    return out;
  });
  const imported = store.importListings(records, { status, replaceExisting: Boolean(replaceExisting) });
  res.json({ ok: true, imported, unmapped, total: store.getListings().length });
});

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * leads
 * ------------------------------------------------------------------ */

app.get('/api/leads', (req, res) => res.json({ ok: true, customers: store.listCustomers() }));

app.put('/api/leads/:jid/notes', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const record = store.getCustomer(jid);
  record.jid = jid;
  record.notes = String(req.body?.notes ?? '');
  if (Array.isArray(req.body?.tags)) record.tags = req.body.tags.map(String);
  store.saveCustomer(record);
  res.json({ ok: true, customer: record });
});

app.delete('/api/leads/:jid', (req, res) => {
  const removed = store.deleteCustomer(decodeURIComponent(req.params.jid));
  if (!removed) return res.status(404).json({ ok: false, message: 'No customer file for that chat.' });
  res.json({ ok: true });
});

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

app.get('/api/leads.csv', (req, res) => {
  const header = ['When', 'Type', 'Chat', 'Name', 'Phone', 'Preferred time', 'Property type', 'Location', 'Expected price', 'Shortlist', 'Reference'];
  const lines = [header.join(',')];
  for (const customer of store.listCustomers()) {
    for (const i of customer.interactions) {
      lines.push(
        [
          i.timestamp,
          i.kind,
          customer.jid,
          i.contactName || customer.name || customer.pushName || '',
          i.contactPhone || customer.phone || '',
          i.preferredTime || '',
          i.propertyType || '',
          i.location || '',
          i.expectedPrice || '',
          (i.shortlist || []).map((p) => `${p.title} (${p.price})`).join(' | '),
          i.ref || '',
        ]
          .map(csvCell)
          .join(',')
      );
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="al-noor-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

/* ------------------------------------------------------------------ *
 * bot control
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * session backup / restore (the workaround for an ephemeral disk)
 * ------------------------------------------------------------------ */

app.get('/api/session/backup', (req, res) => {
  const backup = store.backupSession();
  if (!backup.fileCount) {
    return res.status(400).json({ ok: false, message: 'There is no session to back up yet. Connect and scan the QR first.' });
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="whatsapp-session-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(backup));
});

app.post('/api/session/restore', async (req, res) => {
  if (bot.isConnected()) {
    return res.status(400).json({ ok: false, message: 'Stop the bot before restoring a session.' });
  }
  try {
    const written = store.restoreSession(req.body);
    res.json({ ok: true, message: `Restored ${written} session file(s). Press Connect.` });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * static dashboard
 * ------------------------------------------------------------------ */

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  })
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, message: 'Unknown endpoint.' });
  return res.status(404).send('Not found');
});

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

const server = app.listen(PORT, () => {
  console.log(`\n  ${store.getSettings().business.name} — control dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  data directory: ${store.DATA_DIR}\n`);
  if (String(process.env.AUTOSTART_BOT).toLowerCase() === 'true') {
    console.log('  AUTOSTART_BOT=true — connecting WhatsApp now');
    void bot.start();
  } else {
    console.log('  Open the dashboard and press Connect to bring WhatsApp online.\n');
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — saving state`);
  bot.shutdown();
  store.flushStats();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err?.message || err));