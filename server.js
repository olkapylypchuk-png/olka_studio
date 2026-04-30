require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

const db = new sqlite3.Database(path.join(__dirname, 'olka.db'));
const run = (s,p=[]) => new Promise((res,rej)=>db.run(s,p,function(e){e?rej(e):res(this)}));
const get = (s,p=[]) => new Promise((res,rej)=>db.get(s,p,(e,r)=>e?rej(e):res(r)));
const all = (s,p=[]) => new Promise((res,rej)=>db.all(s,p,(e,r)=>e?rej(e):res(r)));

db.serialize(()=>{
  db.run("CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, email TEXT, services TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, duration_min INTEGER, total_price INTEGER, notes TEXT, photo_path TEXT, notify_sms INTEGER DEFAULT 0, notify_email INTEGER DEFAULT 1, notify_tg INTEGER DEFAULT 0, notify_ig TEXT, notify_fb INTEGER DEFAULT 0, is_gift INTEGER DEFAULT 0, gift_recipient TEXT, gift_contact TEXT, gift_message TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))");
  db.run("CREATE TABLE IF NOT EXISTS gallery (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, caption TEXT, category TEXT DEFAULT 'general', created_at TEXT DEFAULT (datetime('now')))");
  db.run("CREATE TABLE IF NOT EXISTS blocked_times (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, time_from TEXT, time_to TEXT, reason TEXT, all_day INTEGER DEFAULT 0)");
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req,file,cb)=>{
    const dir = path.join(__dirname,'uploads','gallery');
    if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    cb(null,dir);
  },
  filename: (req,file,cb)=>cb(null,Date.now()+path.extname(file.originalname))
});
const upload = multer({storage, limits:{fileSize:10*1024*1024}});

let bot = null;
if(process.env.TELEGRAM_BOT_TOKEN){
  try{
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN,{polling:false});
    console.log('Telegram connected');
  }catch(e){console.log('Telegram error:',e.message);}
}

async function sendTelegram(booking){
  if(!bot||!process.env.TELEGRAM_CHAT_ID) return;
  const svcs = JSON.parse(booking.services||'[]').map(s=>'• '+s.name).join('\n');
  const msg = '🌸 Новий запис — Olka Studio\n\n👤 '+booking.name+'\n📱 '+(booking.phone||'—')+'\n📧 '+(booking.email||'—')+'\n\n💅 Послуги:\n'+svcs+'\n\n📅 '+booking.date+' · 🕐 '+booking.time+'\n⏱ '+booking.duration_min+' хв · 💰 $'+booking.total_price+(booking.notes?'\n📝 '+booking.notes:'')+(booking.is_gift?'\n🎁 Подарунок для: '+booking.gift_recipient:'');
  await bot.sendMessage(process.env.TELEGRAM_CHAT_ID,msg).catch(console.error);
}

let mailer = null;
if(process.env.SMTP_USER && process.env.SMTP_PASS){
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({service:'gmail',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
}

async function sendEmail(booking){
  if(!mailer||!booking.email) return;
  const svcs = JSON.parse(booking.services||'[]').map(s=>'<li>'+s.name+' — $'+s.price+'</li>').join('');
  await mailer.sendMail({
    from: process.env.SMTP_FROM||process.env.SMTP_USER,
    to: booking.email,
    subject: '✨ Olka Studio — Ваш запис на '+booking.date,
    html: '<div style="font-family:Georgia;max-width:500px;background:#0a0a0a;color:#f0ece4;padding:40px;border-radius:16px"><h1 style="color:#c9a96e;font-weight:300">Olka Studio</h1><p>Дякуємо, <b>'+booking.name+'</b>! Оля підтвердить протягом 2 годин.</p><ul style="color:#f0ece4">'+svcs+'</ul><p>📅 '+booking.date+' · 🕐 '+booking.time+' · 💰 $'+booking.total_price+'</p></div>'
  }).catch(console.error);
}
function adminAuth(req,res,next){
  const pwd = req.headers['x-admin-password']||req.query.pwd;
  if(pwd===process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({error:'Unauthorized'});
}

app.post('/api/admin/login',(req,res)=>{
  if(req.body.password===process.env.ADMIN_PASSWORD) res.json({success:true,token:process.env.ADMIN_PASSWORD});
  else res.status(401).json({error:'Wrong password'});
});

app.post('/api/bookings', upload.single('photo'), async(req,res)=>{
  try{
    const b = req.body;
    if(!b.name||!b.services||!b.date||!b.time) return res.status(400).json({error:'Missing fields'});
    const photo_path = req.file?'/uploads/gallery/'+req.file.filename:'';
    const r = await run("INSERT INTO bookings (name,phone,email,services,date,time,duration_min,total_price,notes,photo_path,notify_sms,notify_email,notify_tg,notify_ig,notify_fb,is_gift,gift_recipient,gift_contact,gift_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [b.name,b.phone||'',b.email||'',typeof b.services==='string'?b.services:JSON.stringify(b.services),b.date,b.time,parseInt(b.duration_min)||0,parseInt(b.total_price)||0,b.notes||'',photo_path,b.notify_sms?1:0,b.notify_email?1:0,b.notify_tg?1:0,b.notify_ig||'',b.notify_fb?1:0,b.is_gift?1:0,b.gift_recipient||'',b.gift_contact||'',b.gift_message||'']);
    const booking = await get('SELECT * FROM bookings WHERE id=?',[r.lastID]);
    sendTelegram(booking).catch(console.error);
    if(booking.notify_email) sendEmail(booking).catch(console.error);
    res.json({success:true,booking_id:booking.id});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'});}
});

app.get('/api/bookings', adminAuth, async(req,res)=>{
  let q='SELECT * FROM bookings WHERE 1=1', p=[];
  if(req.query.date){q+=' AND date=?';p.push(req.query.date);}
  if(req.query.status){q+=' AND status=?';p.push(req.query.status);}
  q+=' ORDER BY date ASC,time ASC';
  const rows = await all(q,p);
  res.json(rows.map(b=>Object.assign({},b,{services:JSON.parse(b.services||'[]')})));
});

app.patch('/api/bookings/:id/status', adminAuth, async(req,res)=>{
  await run('UPDATE bookings SET status=? WHERE id=?',[req.body.status,req.params.id]);
  const b = await get('SELECT * FROM bookings WHERE id=?',[req.params.id]);
  res.json({success:true,booking:b});
});

app.get('/api/gallery', async(req,res)=>{
  const photos = await all('SELECT * FROM gallery ORDER BY created_at DESC LIMIT 20');
  res.json(photos);
});

app.post('/api/gallery', adminAuth, upload.single('photo'), async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'});
  const r = await run('INSERT INTO gallery (filename,caption,category) VALUES (?,?,?)',[req.file.filename,req.body.caption||'',req.body.category||'general']);
  res.json({success:true,id:r.lastID,filename:req.file.filename});
});

app.delete('/api/gallery/:id', adminAuth, async(req,res)=>{
  const p = await get('SELECT * FROM gallery WHERE id=?',[req.params.id]);
  if(p){
    const f=path.join(__dirname,'uploads','gallery',p.filename);
    if(fs.existsSync(f)) fs.unlinkSync(f);
    await run('DELETE FROM gallery WHERE id=?',[req.params.id]);
  }
  res.json({success:true});
});

app.get('/api/blocked', async(req,res)=>{
  const rows = req.query.date ? await all('SELECT * FROM blocked_times WHERE date=?',[req.query.date]) : await all('SELECT * FROM blocked_times');
  res.json(rows);
});

app.post('/api/blocked', adminAuth, async(req,res)=>{
  const b = req.body;
  const r = await run('INSERT INTO blocked_times (date,time_from,time_to,reason,all_day) VALUES (?,?,?,?,?)',[b.date,b.time_from||'',b.time_to||'',b.reason||'',b.all_day?1:0]);
  res.json({success:true,id:r.lastID});
});

app.delete('/api/blocked/:id', adminAuth, async(req,res)=>{
  await run('DELETE FROM blocked_times WHERE id=?',[req.params.id]);
  res.json({success:true});
});

app.get('/api/stats', adminAuth, async(req,res)=>{
  const today = new Date().toLocaleDateString('uk-UA');
  const t = await get("SELECT COUNT(*) as c FROM bookings WHERE date=? AND status!='cancelled'",[today]);
const p = await get("SELECT COUNT(*) as c FROM bookings WHERE status='pending'");
  const r = await get("SELECT COALESCE(SUM(total_price),0) as s FROM bookings WHERE status='confirmed' AND created_at>=datetime('now','-7 days')");
  const c = await get("SELECT COUNT(DISTINCT phone) as c FROM bookings WHERE phone!=''");
  res.json({today:t&&t.c||0,pending:p&&p.c||0,week_revenue:r&&r.s||0,total_clients:c&&c.c||0});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT,()=>console.log('Olka Studio running on port '+PORT));
