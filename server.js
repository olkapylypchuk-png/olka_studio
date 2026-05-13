require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'olka2024';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ensure folders
fs.mkdirSync('public/images', { recursive: true });

const db = new sqlite3.Database('./olka.db');

// --- simple auth ---
function checkAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// --- API ---

// GET /api/services
app.get('/api/services', (req, res) => {
  db.all(`SELECT id, name, price, duration, category, image, active
          FROM services_catalog WHERE active=1
          ORDER BY category, name`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    rows = rows.map(r => ({...r, image: r.image || '/images/placeholder.jpg' }));
    res.json(rows);
  });
});

// POST /api/book
app.post('/api/book', async (req, res) => {
  const { name, phone, service_id, date, time, notes } = req.body;
  if (!name ||!phone ||!service_id ||!date ||!time) {
    return res.status(400).json({ error: 'missing fields' });
  }

  db.get('SELECT name FROM services_catalog WHERE id=?', [service_id], async (err, service) => {
    if (err ||!service) return res.status(400).json({ error: 'service not found' });

    const created = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO clients (phone, name) VALUES (?,?)', [phone, name]);
    db.run(`INSERT INTO bookings
      (client_name, phone, service_id, service_name, date, time, notes, created_at, status)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [name, phone, service_id, service.name, date, time, notes || '', created, 'new'],
      async function(err2) {
        if (err2) return res.status(500).json({ error: err2.message });

        const booking = { id: this.lastID, name, phone, service: service.name, date, time, notes };

        // Telegram
        try {
          if (process.env.TELEGRAM_BOT_TOKEN) {
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: `💅 НОВЕ БРОНЮВАННЯ\n${name} ${phone}\n${service.name}\n📅 ${date} ${time}\n${notes||''}`
              })
            });
          }
        } catch {}

        // Make.com webhook (для Google Calendar Олі)
        try {
          if (process.env.MAKE_WEBHOOK_URL) {
            await fetch(process.env.MAKE_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(booking)
            });
          }
        } catch {}

        res.json({ ok: true, id: booking.id });
      });
  });
});

// POST /api/login
app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'wrong password' });
  }
});

// --- ADMIN ---
app.get('/api/admin/bookings', checkAuth, (req, res) => {
  db.all('SELECT * FROM bookings ORDER BY date DESC, time DESC LIMIT 200', [], (e, r) => res.json(r||[]));
});

app.get('/api/admin/clients', checkAuth, (req, res) => {
  db.all('SELECT * FROM clients ORDER BY rowid DESC LIMIT 200', [], (e, r) => res.json(r||[]));
});

app.get('/api/admin/services', checkAuth, (req, res) => {
  db.all('SELECT * FROM services_catalog ORDER BY category, name', [], (e, r) => res.json(r||[]));
});

app.get('/api/admin/stats', checkAuth, (req, res) => {
  db.get('SELECT COUNT(*) as total FROM bookings', [], (e1,r1) => {
    db.get(`SELECT COUNT(*) as month FROM bookings WHERE date >= date('now','start of month')`, [], (e2,r2) => {
      db.get('SELECT COUNT(*) as services FROM services_catalog WHERE active=1', [], (e3,r3) => {
        res.json({ total: r1?.total||0, month: r2?.month||0, services: r3?.services||0 });
      });
    });
  });
});

// upload
const storage = multer.diskStorage({
  destination: 'public/images/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'-'))
});
const upload = multer({ storage });

app.post('/api/admin/upload', checkAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ ok: true, path: '/images/' + req.file.filename });
});

app.post('/api/admin/service-image', checkAuth, (req, res) => {
  const { id, image } = req.body;
  db.run('UPDATE services_catalog SET image=? WHERE id=?', [image, id], err => {
    res.json({ ok:!err });
  });
});

app.listen(PORT, () => console.log('Olka v2 running on :' + PORT));
