require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── FILE UPLOAD ───────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'gallery');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── DATABASE ──────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'olka.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    services TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    duration_min INTEGER,
    total_price INTEGER,
    notes TEXT,
    photo_path TEXT,
    notify_sms INTEGER DEFAULT 0,
    notify_email INTEGER DEFAULT 1,
    notify_tg INTEGER DEFAULT 0,
    notify_ig TEXT,
    notify_fb INTEGER DEFAULT 0,
    is_gift INTEGER DEFAULT 0,
    gift_recipient TEXT,
    gift_contact TEXT,
    gift_message TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS gallery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    caption TEXT,
    category TEXT DEFAULT 'general',
    published_ig INTEGER DEFAULT 0,
    published_fb INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocked_times (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time_from TEXT,
    time_to TEXT,
    reason TEXT,
    all_day INTEGER DEFAULT 0
  );
`);

// ── TELEGRAM ──────────────────────────────────────────────────────────
let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== 'your_bot_token_here') {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
    console.log('✅ Telegram bot connected');
  } catch (e) {
    console.log('⚠️  Telegram not configured:', e.message);
  }
}

async function sendTelegramNotification(booking) {
  if (!bot || !process.env.TELEGRAM_CHAT_ID) return;
  const services = JSON.parse(booking.services).map(s => `• ${s.name}`).join('\n');
  const msg = `
🌸 *Новий запис — Olka Studio*

👤 *Клієнт:* ${booking.name}
📱 *Телефон:* ${booking.phone || '—'}
📧 *Email:* ${booking.email || '—'}

💅 *Послуги:*
${services}

📅 *Дата:* ${booking.date}
🕐 *Час:* ${booking.time}
⏱ *Тривалість:* ${booking.duration_min} хв
💰 *Вартість:* $${booking.total_price}

${booking.notes ? `📝 *Нотатки:* ${booking.notes}` : ''}
${booking.is_gift ? `🎁 *ПОДАРУНОК для:* ${booking.gift_recipient}` : ''}
${booking.photo_path ? '📸 *Є фото-натхнення*' : ''}

_Статус: очікує підтвердження_
  `.trim();

  try {
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    if (booking.photo_path) {
      await bot.sendPhoto(process.env.TELEGRAM_CHAT_ID,
        path.join(__dirname, booking.photo_path),
        { caption: 'Фото-натхнення від клієнта' }
      );
    }
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

// ── EMAIL ─────────────────────────────────────────────────────────────
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_PASS !== 'your_app_password_here') {
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log('✅ Email configured');
}

async function sendClientEmail(booking) {
  if (!transporter || !booking.email) return;
  const services = JSON.parse(booking.services).map(s => `<li>${s.name} — $${s.price}</li>`).join('');
  const html = `
    <div style="font-family:Georgia,serif;max-width:500px;margin:0 auto;background:#0a0a0a;color:#f0ece4;padding:40px;border-radius:16px">
      <h1 style="font-size:28px;font-weight:300;color:#c9a96e;margin-bottom:4px">Olka Studio</h1>
      <p style="color:#888;font-size:12px;letter-spacing:2px;text-transform:uppercase">Hamilton, Ontario</p>
      <hr style="border:none;border-top:1px solid #222;margin:24px 0">
      <h2 style="font-weight:300;font-size:20px">✨ Ваш запис отримано!</h2>
      <p style="color:#aaa;line-height:1.6">Дякуємо, <strong style="color:#f0ece4">${booking.name}</strong>! Оля розгляне ваш запит і підтвердить протягом 2 годин.</p>
      <div style="background:#111;border:1px solid #222;border-radius:12px;padding:20px;margin:20px 0">
        <p><strong style="color:#c9a96e">Послуги:</strong></p>
        <ul style="color:#f0ece4;line-height:2">${services}</ul>
        <p><strong style="color:#c9a96e">Дата:</strong> ${booking.date}</p>
        <p><strong style="color:#c9a96e">Час:</strong> ${booking.time}</p>
        <p><strong style="color:#c9a96e">Тривалість:</strong> ${booking.duration_min} хв</p>
        <p><strong style="color:#c9a96e">Орієнтовна вартість:</strong> $${booking.total_price}</p>
      </div>
      <p style="color:#666;font-size:11px">Olka Studio · Hamilton, ON · olkastudio.ca</p>
    </div>`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: booking.email,
      subject: `✨ Olka Studio — Ваш запис на ${booking.date}`,
      html
    });
  } catch (e) {
    console.error('Email send error:', e.message);
  }
}

// ── GOOGLE CALENDAR ───────────────────────────────────────────────────
async function addToGoogleCalendar(booking) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON === '{}') return;
  try {
    const { google } = require('googleapis');
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const [day, month, year] = booking.date.split('.').map(Number);
    const [hour, minute] = booking.time.split(':').map(Number);
    const start = new Date(year, month - 1, day, hour, minute);
    const end = new Date(start.getTime() + booking.duration_min * 60000);

    const services = JSON.parse(booking.services).map(s => s.name).join(', ');

    await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `💅 ${booking.name} — ${services}`,
        description: `Клієнт: ${booking.name}\nТел: ${booking.phone}\nEmail: ${booking.email}\nВартість: $${booking.total_price}\n${booking.notes ? 'Нотатки: ' + booking.notes : ''}`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Toronto' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Toronto' },
        colorId: '11', // red-ish for nail bookings
      }
    });
    console.log('✅ Added to Google Calendar');
  } catch (e) {
    console.error('Google Calendar error:', e.message);
  }
}

// ── ROUTES: BOOKINGS ──────────────────────────────────────────────────

// POST /api/bookings — new booking from client
app.post('/api/bookings', upload.single('photo'), async (req, res) => {
  try {
    const {
      name, phone, email, services, date, time,
      duration_min, total_price, notes,
      notify_sms, notify_email, notify_tg, notify_ig, notify_fb,
      is_gift, gift_recipient, gift_contact, gift_message
    } = req.body;

    if (!name || !services || !date || !time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const photo_path = req.file ? `/uploads/gallery/${req.file.filename}` : null;

    const stmt = db.prepare(`
      INSERT INTO bookings
        (name, phone, email, services, date, time, duration_min, total_price,
         notes, photo_path, notify_sms, notify_email, notify_tg, notify_ig,
         notify_fb, is_gift, gift_recipient, gift_contact, gift_message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const result = stmt.run(
      name, phone || '', email || '',
      typeof services === 'string' ? services : JSON.stringify(services),
      date, time,
      parseInt(duration_min) || 0,
      parseInt(total_price) || 0,
      notes || '', photo_path || '',
      notify_sms ? 1 : 0, notify_email ? 1 : 0,
      notify_tg ? 1 : 0, notify_ig || '',
      notify_fb ? 1 : 0,
      is_gift ? 1 : 0,
      gift_recipient || '', gift_contact || '', gift_message || ''
    );

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

    // Fire notifications (non-blocking)
    Promise.all([
      sendTelegramNotification(booking),
      booking.notify_email ? sendClientEmail(booking) : Promise.resolve(),
      addToGoogleCalendar(booking)
    ]).catch(console.error);

    res.json({ success: true, booking_id: booking.id });
  } catch (e) {
    console.error('Booking error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/bookings — all bookings (admin)
app.get('/api/bookings', requireAdmin, (req, res) => {
  const { date, status } = req.query;
  let query = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];
  if (date) { query += ' AND date = ?'; params.push(date); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY date ASC, time ASC';
  const bookings = db.prepare(query).all(...params);
  res.json(bookings.map(b => ({ ...b, services: JSON.parse(b.services || '[]') })));
});

// PATCH /api/bookings/:id/status — confirm or cancel
app.patch('/api/bookings/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body; // 'confirmed' | 'cancelled'
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, req.params.id);
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);

  // Notify client via Telegram if confirmed
  if (status === 'confirmed' && bot && booking.notify_tg) {
    bot.sendMessage(process.env.TELEGRAM_CHAT_ID,
      `✅ Запис підтверджено для ${booking.name} на ${booking.date} о ${booking.time}`
    ).catch(console.error);
  }

  res.json({ success: true, booking });
});

// ── ROUTES: GALLERY ───────────────────────────────────────────────────

// GET /api/gallery — last 20 photos for client homepage
app.get('/api/gallery', (req, res) => {
  const photos = db.prepare(
    'SELECT * FROM gallery ORDER BY created_at DESC LIMIT 20'
  ).all();
  res.json(photos);
});

// POST /api/gallery — Olya uploads new photo (admin)
app.post('/api/gallery', requireAdmin, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { caption, category } = req.body;
  const stmt = db.prepare(
    'INSERT INTO gallery (filename, caption, category) VALUES (?, ?, ?)'
  );
  const result = stmt.run(req.file.filename, caption || '', category || 'general');
  res.json({ success: true, id: result.lastInsertRowid, filename: req.file.filename });
});

// DELETE /api/gallery/:id
app.delete('/api/gallery/:id', requireAdmin, (req, res) => {
  const photo = db.prepare('SELECT * FROM gallery WHERE id = ?').get(req.params.id);
  if (photo) {
    const filePath = path.join(__dirname, 'uploads', 'gallery', photo.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM gallery WHERE id = ?').run(req.params.id);
  }
  res.json({ success: true });
});

// ── ROUTES: BLOCKED TIMES ─────────────────────────────────────────────

app.get('/api/blocked', (req, res) => {
  const { date } = req.query;
  const rows = date
    ? db.prepare('SELECT * FROM blocked_times WHERE date = ?').all(date)
    : db.prepare('SELECT * FROM blocked_times').all();
  res.json(rows);
});

app.post('/api/blocked', requireAdmin, (req, res) => {
  const { date, time_from, time_to, reason, all_day } = req.body;
  const result = db.prepare(
    'INSERT INTO blocked_times (date, time_from, time_to, reason, all_day) VALUES (?,?,?,?,?)'
  ).run(date, time_from || '', time_to || '', reason || '', all_day ? 1 : 0);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.delete('/api/blocked/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM blocked_times WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── ROUTES: STATS (admin dashboard) ──────────────────────────────────

app.get('/api/stats', requireAdmin, (req, res) => {
  const today = new Date().toLocaleDateString('uk-UA');
  const stats = {
    today: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE date = ? AND status != 'cancelled'").get(today)?.c || 0,
    pending: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status = 'pending'").get()?.c || 0,
    week_revenue: db.prepare(`
      SELECT COALESCE(SUM(total_price),0) as s FROM bookings
      WHERE status = 'confirmed'
      AND created_at >= datetime('now', '-7 days')
    `).get()?.s || 0,
    total_clients: db.prepare("SELECT COUNT(DISTINCT phone) as c FROM bookings WHERE phone != ''").get()?.c || 0,
  };
  res.json(stats);
});

// ── ADMIN AUTH ────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, token: process.env.ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ── CATCH-ALL → index.html ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌸 Olka Studio server running on port ${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin`);
  console.log(`   Telegram: ${bot ? '✅ connected' : '⚠️  not configured'}`);
  console.log(`   Email: ${transporter ? '✅ configured' : '⚠️  not configured'}\n`);
});
