'use strict';

const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const Database     = require('better-sqlite3');
const compression  = require('compression');
const rateLimit    = require('express-rate-limit');
const nodemailer   = require('nodemailer');
require('dotenv').config();

// ─── ENV ──────────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3000;
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'olka2024secret';
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID   || '';
const SMTP_USER    = process.env.SMTP_USER || '';
const SMTP_PASS    = process.env.SMTP_PASS || '';
const WEBHOOK_URL  = process.env.MAKE_WEBHOOK_URL   || '';
const DB_PATH      = process.env.DB_PATH || path.join(__dirname, 'data', 'olka.db');

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    email       TEXT,
    services    TEXT NOT NULL,
    date        TEXT NOT NULL,
    time        TEXT NOT NULL,
    notes       TEXT,
    total       REAL DEFAULT 0,
    duration    INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'pending',
    is_gift     INTEGER DEFAULT 0,
    gift_name   TEXT,
    gift_contact TEXT,
    lang        TEXT DEFAULT 'en',
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT UNIQUE NOT NULL,
    email      TEXT,
    notes      TEXT,
    visit_count INTEGER DEFAULT 0,
    last_visit  TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS services_catalog (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name_en     TEXT NOT NULL,
    name_uk     TEXT NOT NULL,
    price       REAL NOT NULL,
    duration    INTEGER NOT NULL,
    category    TEXT DEFAULT 'nails',
    active      INTEGER DEFAULT 1
  );
`);

// Seed default services if empty
const serviceCount = db.prepare('SELECT COUNT(*) as c FROM services_catalog').get().c;
if (serviceCount === 0) {
  const insertSvc = db.prepare(`INSERT INTO services_catalog (name_en,name_uk,price,duration,category) VALUES (?,?,?,?,?)`);
  const seedServices = db.transaction(() => {
    insertSvc.run('Classic Manicure',        'Класичний манікюр',          35, 60,  'nails');
    insertSvc.run('Gel Manicure',            'Гелевий манікюр',            50, 75,  'nails');
    insertSvc.run('Classic Pedicure',        'Класичний педикюр',          45, 60,  'nails');
    insertSvc.run('Gel Pedicure',            'Гелевий педикюр',            60, 75,  'nails');
    insertSvc.run('Nail Art (per nail)',     'Нейл-арт (за ніготь)',        5, 5,   'art');
    insertSvc.run('Full Set Acrylic',        'Акрилові нігті (повний набір)',80, 90, 'nails');
    insertSvc.run('Nail Removal',            'Зняття покриття',            20, 30,  'nails');
    insertSvc.run('Eyebrow Shaping',         'Корекція брів',              20, 20,  'beauty');
    insertSvc.run('Eyebrow Tinting',         'Фарбування брів',            25, 30,  'beauty');
    insertSvc.run('Lash Lift',               'Ламінування вій',            60, 60,  'beauty');
  });
  seedServices();
}

// ─── APP ──────────────────────────────────────────────────────────────────────
const app = express();

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files with cache headers
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const bookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts.' }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

async function sendEmail(to, subject, html) {
  if (!SMTP_USER || !SMTP_PASS || !to) return;
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    await transporter.sendMail({ from: SMTP_USER, to, subject, html });
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

async function sendMakeWebhook(data) {
  if (!WEBHOOK_URL) return;
  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (e) {
    console.error('Make webhook error:', e.message);
  }
}

function isValidBookingTime(dateStr, timeStr) {
  const date = new Date(`${dateStr}T${timeStr}`);
  const day  = date.getDay(); // 0=Sun, 6=Sat
  const hour = date.getHours();
  if (day === 0) return false;          // Sunday blocked
  if (hour < 8 || hour >= 20) return false; // outside 8-20
  return true;
}

function upsertClient(name, phone, email) {
  const existing = db.prepare('SELECT id FROM clients WHERE phone=?').get(phone);
  if (existing) {
    db.prepare(`UPDATE clients SET visit_count=visit_count+1, last_visit=date('now'), name=? WHERE phone=?`)
      .run(name, phone);
    return existing.id;
  } else {
    const r = db.prepare(`INSERT INTO clients (name,phone,email) VALUES (?,?,?)`)
      .run(name, phone, email || null);
    return r.lastInsertRowid;
  }
}

// ─── API: HEALTH ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  let dbOk = false;
  try { db.prepare('SELECT 1').get(); dbOk = true; } catch {}
  res.json({ status: 'ok', db: dbOk, uptime: process.uptime() });
});

// ─── API: SERVICES ────────────────────────────────────────────────────────────
app.get('/api/services', (req, res) => {
  const services = db.prepare('SELECT * FROM services_catalog WHERE active=1 ORDER BY category,id').all();
  res.json(services);
});

// ─── API: AVAILABILITY ────────────────────────────────────────────────────────
app.get('/api/availability', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  const d = new Date(date);
  if (d.getDay() === 0) return res.json({ available: false, reason: 'Sunday closed' });

  const booked = db.prepare(`
    SELECT time FROM bookings WHERE date=? AND status != 'cancelled'
  `).all(date).map(r => r.time);

  const slots = [];
  for (let h = 8; h < 20; h++) {
    for (let m = 0; m < 60; m += 30) {
      const t = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      slots.push({ time: t, available: !booked.includes(t) });
    }
  }
  res.json({ available: true, slots });
});

// ─── API: BOOK ────────────────────────────────────────────────────────────────
app.post('/api/book', bookLimiter, async (req, res) => {
  const { name, phone, email, services, date, time, notes, total, duration,
          is_gift, gift_name, gift_contact, lang } = req.body;

  if (!name || !phone || !services || !date || !time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!isValidBookingTime(date, time)) {
    return res.status(400).json({ error: 'Invalid booking time (Sun closed, hours 8-20 only)' });
  }

  // Check slot conflict
  const conflict = db.prepare(`
    SELECT id FROM bookings WHERE date=? AND time=? AND status != 'cancelled'
  `).get(date, time);
  if (conflict) return res.status(409).json({ error: 'Time slot already booked' });

  const result = db.prepare(`
    INSERT INTO bookings (name,phone,email,services,date,time,notes,total,duration,is_gift,gift_name,gift_contact,lang)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    name, phone, email || null,
    typeof services === 'string' ? services : JSON.stringify(services),
    date, time, notes || null,
    total || 0, duration || 0,
    is_gift ? 1 : 0, gift_name || null, gift_contact || null,
    lang || 'en'
  );

  upsertClient(name, phone, email);

  const bookingId = result.lastInsertRowid;
  const servicesList = typeof services === 'string' ? services : JSON.stringify(services);

  // Telegram notification
  const tgMsg = `
🌸 <b>New Booking #${bookingId}</b>
👤 ${name} | 📞 ${phone}
💅 ${servicesList}
📅 ${date} at ${time}
💰 $${total || 0} · ⏱ ${duration || 0} min
${notes ? '📝 ' + notes : ''}
${is_gift ? `🎁 Gift for: ${gift_name} (${gift_contact})` : ''}
  `.trim();
  sendTelegram(tgMsg);

  // Email confirmation
  if (email) {
    sendEmail(email, 'Booking Confirmed — Olka Studio', `
      <h2>Thank you, ${name}!</h2>
      <p>Your booking has been received.</p>
      <p><b>Services:</b> ${servicesList}<br>
      <b>Date:</b> ${date} at ${time}<br>
      <b>Total:</b> $${total || 0}</p>
      <p>Olya will confirm within 2 hours. Questions? Email olkapylypchuk@gmail.com</p>
      <p>— Olka Studio, Hamilton ON</p>
    `);
  }

  // Make.com → Google Calendar
  sendMakeWebhook({ name, phone, email, service: servicesList, date, time, notes, total });

  res.json({ ok: true, id: bookingId });
});

// ─── API: LOGIN ───────────────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Plain text compare (bcrypt-ready: just swap with bcrypt.compareSync if you hash later)
  if (password === ADMIN_PASS) {
    return res.json({ ok: true, token: Buffer.from(`olka:${Date.now()}`).toString('base64') });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// ─── API: ADMIN BOOKINGS ──────────────────────────────────────────────────────
app.get('/api/admin/bookings', (req, res) => {
  const auth = req.headers['x-admin-token'] || '';
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { status, date, search, page = 1, limit = 50 } = req.query;
  let sql = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status=?'; params.push(status); }
  if (date)   { sql += ' AND date=?';   params.push(date); }
  if (search) {
    sql += ' AND (name LIKE ? OR phone LIKE ? OR services LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  sql += ' ORDER BY date DESC, time DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));

  const bookings = db.prepare(sql).all(...params);
  const total    = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
  res.json({ bookings, total });
});

app.patch('/api/admin/bookings/:id', (req, res) => {
  const auth = req.headers['x-admin-token'] || '';
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { status, notes } = req.body;
  const { id } = req.params;
  db.prepare('UPDATE bookings SET status=?, notes=? WHERE id=?').run(status, notes, id);
  res.json({ ok: true });
});

// ─── API: ADMIN CLIENTS ───────────────────────────────────────────────────────
app.get('/api/admin/clients', (req, res) => {
  const auth = req.headers['x-admin-token'] || '';
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const clients = db.prepare('SELECT * FROM clients ORDER BY visit_count DESC, last_visit DESC').all();
  res.json(clients);
});

// ─── API: ADMIN SERVICES ──────────────────────────────────────────────────────
app.get('/api/admin/services', (req, res) => {
  const auth = req.headers['x-admin-token'] || '';
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  res.json(db.prepare('SELECT * FROM services_catalog ORDER BY id').all());
});

app.post('/api/admin/services', (req, res) => {
  const auth = req.headers['x-admin-token'] || '';
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { name_en, name_uk, price, duration, category } = req.body;
  const r = db.prepare('INSERT INTO services_catalog (name_en,name_uk,price,duration,category) VALUES (?,?,?,?,?)')
    .run(name_en, name_uk, price, duration, category || 'nails');
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.patch('/api/admin/services/:id', (req, res) => {
  const auth = req.headers['x-admin-token'] || '';
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { name_en, name_uk, price, duration, category, active } = req.body;
  db.prepare('UPDATE services_catalog SET name_en=?,name_uk=?,price=?,duration=?,category=?,active=? WHERE id=?')
    .run(name_en, name_uk, price, duration, category, active, req.params.id);
  res.json({ ok: true });
});

// ─── API: ADMIN STATS ─────────────────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  const auth = req.headers['x-admin-token'] || '';
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const today        = new Date().toISOString().split('T')[0];
  const monthStart   = today.substring(0, 7) + '-01';

  const stats = {
    total_bookings:   db.prepare('SELECT COUNT(*) as c FROM bookings').get().c,
    today_bookings:   db.prepare('SELECT COUNT(*) as c FROM bookings WHERE date=?').get(today).c,
    month_bookings:   db.prepare('SELECT COUNT(*) as c FROM bookings WHERE date>=?').get(monthStart).c,
    pending:          db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='pending'").get().c,
    confirmed:        db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status='confirmed'").get().c,
    total_clients:    db.prepare('SELECT COUNT(*) as c FROM clients').get().c,
    month_revenue:    db.prepare("SELECT SUM(total) as s FROM bookings WHERE date>=? AND status!='cancelled'").get(monthStart).s || 0,
    upcoming:         db.prepare("SELECT * FROM bookings WHERE date>=? AND status!='cancelled' ORDER BY date,time LIMIT 5").all(today),
  };
  res.json(stats);
});

// ─── API: PUBLIC BOOKING BY ID ────────────────────────────────────────────────
app.get('/api/booking/:id', (req, res) => {
  const b = db.prepare('SELECT id,name,services,date,time,status,total FROM bookings WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(b);
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Olka Studio running on port ${PORT}`);
  console.log(`📁 Database: ${DB_PATH}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
});
