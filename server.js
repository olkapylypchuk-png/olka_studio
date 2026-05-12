'use strict';

const express     = require('express');
const path        = require('path');
const fs          = require('fs');
const sqlite3     = require('sqlite3').verbose();
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const nodemailer  = require('nodemailer');
require('dotenv').config();

// ─── ENV ──────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD  || 'olka2024secret';
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID   || '';
const SMTP_USER   = process.env.SMTP_USER || '';
const SMTP_PASS   = process.env.SMTP_PASS || '';
const WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL  || '';
const DB_PATH     = process.env.DB_PATH || path.join(__dirname, 'data', 'olka.db');

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB error:', err);
  else     console.log('📁 DB connected:', DB_PATH);
});

const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else     resolve({ lastID: this.lastID, changes: this.changes });
  });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
    services TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
    notes TEXT, total REAL DEFAULT 0, duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    is_gift INTEGER DEFAULT 0, gift_name TEXT, gift_contact TEXT,
    lang TEXT DEFAULT 'en',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, email TEXT, notes TEXT,
    visit_count INTEGER DEFAULT 0, last_visit TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS services_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_en TEXT NOT NULL, name_uk TEXT NOT NULL,
    price REAL NOT NULL, duration INTEGER NOT NULL,
    category TEXT DEFAULT 'nails', active INTEGER DEFAULT 1
  )`, () => {
    db.get('SELECT COUNT(*) as c FROM services_catalog', (err, row) => {
      if (!err && row && row.c === 0) {
        const seed = [
          ['Classic Manicure','Класичний манікюр',35,60,'nails'],
          ['Gel Manicure','Гелевий манікюр',50,75,'nails'],
          ['Classic Pedicure','Класичний педикюр',45,60,'nails'],
          ['Gel Pedicure','Гелевий педикюр',60,75,'nails'],
          ['Nail Art (per nail)','Нейл-арт (за ніготь)',5,5,'art'],
          ['Full Set Acrylic','Акрилові нігті',80,90,'nails'],
          ['Nail Removal','Зняття покриття',20,30,'nails'],
          ['Eyebrow Shaping','Корекція брів',20,20,'beauty'],
          ['Eyebrow Tinting','Фарбування брів',25,30,'beauty'],
          ['Lash Lift','Ламінування вій',60,60,'beauty'],
        ];
        const stmt = db.prepare('INSERT INTO services_catalog (name_en,name_uk,price,duration,category) VALUES (?,?,?,?,?)');
        seed.forEach(s => stmt.run(s));
        stmt.finalize();
        console.log('✨ Seeded default services');
      }
    });
  });
});

// ─── APP ──────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d', etag: true,
  setHeaders(res, p) { if (p.endsWith('.html')) res.setHeader('Cache-Control','no-cache'); }
}));

const bookLimiter  = rateLimit({ windowMs: 60*1000,    max: 10, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, standardHeaders: true, legacyHeaders: false });

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode:'HTML' })
    });
  } catch (e) { console.error('TG:', e.message); }
}

async function sendEmail(to, subject, html) {
  if (!SMTP_USER || !SMTP_PASS || !to) return;
  try {
    const t = nodemailer.createTransport({ service:'gmail', auth:{ user:SMTP_USER, pass:SMTP_PASS }});
    await t.sendMail({ from: SMTP_USER, to, subject, html });
  } catch (e) { console.error('Email:', e.message); }
}

async function sendMakeWebhook(data) {
  if (!WEBHOOK_URL) return;
  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(WEBHOOK_URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
  } catch (e) { console.error('Make:', e.message); }
}

function isValidBookingTime(dateStr, timeStr) {
  const d = new Date(`${dateStr}T${timeStr}`);
  const day = d.getDay(), hr = d.getHours();
  if (day === 0) return false;
  if (hr < 8 || hr >= 20) return false;
  return true;
}

async function upsertClient(name, phone, email) {
  const ex = await get('SELECT id FROM clients WHERE phone=?', [phone]);
  if (ex) {
    await run(`UPDATE clients SET visit_count=visit_count+1, last_visit=date('now'), name=? WHERE phone=?`, [name, phone]);
    return ex.id;
  }
  const r = await run('INSERT INTO clients (name,phone,email) VALUES (?,?,?)', [name, phone, email || null]);
  return r.lastID;
}

function requireAuth(req, res, next) {
  if (!req.headers['x-admin-token']) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbOk = false;
  try { await get('SELECT 1'); dbOk = true; } catch {}
  res.json({ status:'ok', db: dbOk, uptime: process.uptime() });
});

app.get('/api/services', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM services_catalog WHERE active=1 ORDER BY category,id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  if (new Date(date).getDay() === 0) return res.json({ available: false, reason: 'Sunday closed' });
  const booked = (await all(`SELECT time FROM bookings WHERE date=? AND status!='cancelled'`, [date])).map(r => r.time);
  const slots = [];
  for (let h = 8; h < 20; h++) for (let m = 0; m < 60; m += 30) {
    const t = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    slots.push({ time: t, available: !booked.includes(t) });
  }
  res.json({ available: true, slots });
});

app.post('/api/book', bookLimiter, async (req, res) => {
  try {
    const { name, phone, email, services, date, time, notes, total, duration,
            is_gift, gift_name, gift_contact, lang } = req.body;
    if (!name || !phone || !services || !date || !time)
      return res.status(400).json({ error: 'Missing required fields' });
    if (!isValidBookingTime(date, time))
      return res.status(400).json({ error: 'Invalid time (Sun closed, hours 8-20)' });

    const conflict = await get(`SELECT id FROM bookings WHERE date=? AND time=? AND status!='cancelled'`, [date, time]);
    if (conflict) return res.status(409).json({ error: 'Slot already booked' });

    const svcStr = typeof services === 'string' ? services : JSON.stringify(services);
    const r = await run(`INSERT INTO bookings
      (name,phone,email,services,date,time,notes,total,duration,is_gift,gift_name,gift_contact,lang)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, phone, email||null, svcStr, date, time, notes||null, total||0, duration||0,
       is_gift?1:0, gift_name||null, gift_contact||null, lang||'en']);

    await upsertClient(name, phone, email);

    const id = r.lastID;
    sendTelegram(`🌸 <b>New Booking #${id}</b>\n👤 ${name} | 📞 ${phone}\n💅 ${svcStr}\n📅 ${date} at ${time}\n💰 $${total||0} · ⏱ ${duration||0} min\n${notes?'📝 '+notes:''}\n${is_gift?`🎁 Gift: ${gift_name} (${gift_contact})`:''}`.trim());
    if (email) sendEmail(email, 'Booking Confirmed — Olka Studio',
      `<h2>Thank you, ${name}!</h2><p><b>Services:</b> ${svcStr}<br><b>Date:</b> ${date} at ${time}<br><b>Total:</b> $${total||0}</p><p>Olya will confirm within 2 hours.</p><p>— Olka Studio, Hamilton ON</p>`);
    sendMakeWebhook({ name, phone, email, service: svcStr, date, time, notes, total });

    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password === ADMIN_PASS)
    return res.json({ ok: true, token: Buffer.from(`olka:${Date.now()}`).toString('base64') });
  res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/admin/bookings', requireAuth, async (req, res) => {
  try {
    const { status, date, search, page=1, limit=50 } = req.query;
    let sql = 'SELECT * FROM bookings WHERE 1=1';
    const p = [];
    if (status) { sql += ' AND status=?'; p.push(status); }
    if (date)   { sql += ' AND date=?';   p.push(date); }
    if (search) { sql += ' AND (name LIKE ? OR phone LIKE ? OR services LIKE ?)';
                  const s=`%${search}%`; p.push(s,s,s); }
    sql += ' ORDER BY date DESC, time DESC LIMIT ? OFFSET ?';
    p.push(Number(limit), (Number(page)-1)*Number(limit));
    const bookings = await all(sql, p);
    const t = await get('SELECT COUNT(*) as c FROM bookings');
    res.json({ bookings, total: t.c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/bookings/:id', requireAuth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    await run('UPDATE bookings SET status=?, notes=? WHERE id=?', [status, notes, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/clients', requireAuth, async (req, res) => {
  try {
    const rows = await all('SELECT * FROM clients ORDER BY visit_count DESC, last_visit DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/services', requireAuth, async (req, res) => {
  try { res.json(await all('SELECT * FROM services_catalog ORDER BY id')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/services', requireAuth, async (req, res) => {
  try {
    const { name_en, name_uk, price, duration, category } = req.body;
    const r = await run('INSERT INTO services_catalog (name_en,name_uk,price,duration,category) VALUES (?,?,?,?,?)',
      [name_en, name_uk, price, duration, category || 'nails']);
    res.json({ ok: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/services/:id', requireAuth, async (req, res) => {
  try {
    const { name_en, name_uk, price, duration, category, active } = req.body;
    await run('UPDATE services_catalog SET name_en=?,name_uk=?,price=?,duration=?,category=?,active=? WHERE id=?',
      [name_en, name_uk, price, duration, category, active, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const mStart = today.substring(0,7) + '-01';
    const stats = {
      total_bookings: (await get('SELECT COUNT(*) as c FROM bookings')).c,
      today_bookings: (await get('SELECT COUNT(*) as c FROM bookings WHERE date=?', [today])).c,
      month_bookings: (await get('SELECT COUNT(*) as c FROM bookings WHERE date>=?', [mStart])).c,
      pending:        (await get("SELECT COUNT(*) as c FROM bookings WHERE status='pending'")).c,
      confirmed:      (await get("SELECT COUNT(*) as c FROM bookings WHERE status='confirmed'")).c,
      total_clients:  (await get('SELECT COUNT(*) as c FROM clients')).c,
      month_revenue:  (await get("SELECT SUM(total) as s FROM bookings WHERE date>=? AND status!='cancelled'", [mStart])).s || 0,
      upcoming:       await all("SELECT * FROM bookings WHERE date>=? AND status!='cancelled' ORDER BY date,time LIMIT 5", [today]),
    };
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/booking/:id', async (req, res) => {
  const b = await get('SELECT id,name,services,date,time,status,total FROM bookings WHERE id=?', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(b);
});

app.listen(PORT, () => {
  console.log(`✅ Olka Studio running on port ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
});
