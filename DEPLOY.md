# 🍓 OLKA STUDIO — Raspberry Pi 4 Deployment Guide

## КРОК 1 — Встанови Node.js 20 на Pi

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # має бути v20.x.x
```

---

## КРОК 2 — Встанови PM2 (менеджер процесів)

```bash
sudo npm install -g pm2
pm2 --version
```

---

## КРОК 3 — Клонуй проект з GitHub

```bash
cd ~
git clone https://github.com/olkapylypchuk-png/olka_studio.git
cd olka_studio
```

---

## КРОК 4 — Завантаж нові файли в GitHub (СПОЧАТКУ)

Перед деплоєм на Pi — завантаж нові файли в GitHub:

1. Відкрий https://github.com/olkapylypchuk-png/olka_studio
2. Натисни **Add file → Upload files**
3. Завантаж:
   - `server.js` (новий)
   - `public/admin.html` (новий)
   - `package.json` (новий)
   - `ecosystem.config.js` (новий)
   - `.env.example` (новий)
4. Натисни **Commit changes**

Потім на Pi:
```bash
git pull origin main
```

---

## КРОК 5 — Налаштуй .env

```bash
cp .env.example .env
nano .env
```

Заповни:
```
PORT=3000
ADMIN_PASSWORD=придумай_складний_пароль
TELEGRAM_BOT_TOKEN=твій_токен
TELEGRAM_CHAT_ID=1218454528
SMTP_USER=olkapylypchuk@gmail.com
SMTP_PASS=твій_gmail_app_password
DB_PATH=/home/pi/olka_studio/data/olka.db
```

Зберегти: **Ctrl+O → Enter → Ctrl+X**

---

## КРОК 6 — Встанови залежності

```bash
npm install
```

Якщо помилка з better-sqlite3:
```bash
sudo apt-get install -y python3 make g++ libsqlite3-dev
npm install --build-from-source
```

---

## КРОК 7 — Тест запуску

```bash
node server.js
```

Маєш побачити:
```
✅ Olka Studio running on port 3000
📁 Database: /home/pi/olka_studio/data/olka.db
🌐 Health: http://localhost:3000/health
```

Перевір в браузері Pi: http://localhost:3000

**Ctrl+C** — зупини

---

## КРОК 8 — Запуск через PM2

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # скопіюй і виконай команду яку видасть
```

Команди PM2:
```bash
pm2 status          # статус
pm2 logs olka-studio # логи в реальному часі
pm2 restart olka-studio
pm2 stop olka-studio
```

---

## КРОК 9 — Cloudflare Tunnel (замість port forwarding)

### 9.1 Встанови cloudflared

```bash
# Для Raspberry Pi (ARM64):
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared-linux-arm64.deb

# Або для ARM32 (старіший Pi):
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm.deb
sudo dpkg -i cloudflared-linux-arm.deb
```

### 9.2 Авторизація

```bash
cloudflared tunnel login
```
Відкриє браузер → увійди в Cloudflare акаунт → обери свій домен

### 9.3 Створи tunnel

```bash
cloudflared tunnel create olka-studio
```
Запам'ятай UUID (наприклад: `a1b2c3d4-...`)

### 9.4 Налаштуй конфіг

```bash
mkdir -p ~/.cloudflared
nano ~/.cloudflared/config.yml
```

Вміст файлу:
```yaml
tunnel: a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx  # твій UUID
credentials-file: /home/pi/.cloudflared/a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json

ingress:
  - hostname: olkastudio.ca        # твій домен
    service: http://localhost:3000
  - service: http_status:404
```

### 9.5 Додай DNS запис

```bash
cloudflared tunnel route dns olka-studio olkastudio.ca
```

### 9.6 Запусти як сервіс (автостарт)

```bash
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
sudo systemctl status cloudflared
```

### 9.7 Перевірка

Відкрий https://olkastudio.ca — сайт має працювати! 🎉

---

## КРОК 10 — Оновлення сайту в майбутньому

Коли треба оновити файли:

```bash
cd ~/olka_studio
git pull origin main
npm install          # тільки якщо змінився package.json
pm2 restart olka-studio
```

---

## 🔧 ДІАГНОСТИКА

### Сайт не відкривається
```bash
pm2 status                    # перевір статус
pm2 logs olka-studio --lines 50  # дивись помилки
curl http://localhost:3000/health  # тест локально
```

### Cloudflare не з'єднується
```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 50
```

### Проблема з БД
```bash
ls -la ~/olka_studio/data/    # перевір чи є файл .db
```

---

## 📋 ФІНАЛЬНИЙ ЧЕКЛИСТ

- [ ] Node.js 20 встановлено (`node --version`)
- [ ] PM2 встановлено і запущено
- [ ] .env заповнений (пароль, Telegram, Gmail)
- [ ] `npm install` успішно
- [ ] Сайт відкривається на http://localhost:3000
- [ ] Admin панель: http://localhost:3000/admin.html
- [ ] Cloudflared встановлено і налаштовано
- [ ] Домен вказує на Cloudflare
- [ ] Сайт відкривається через домен з HTTPS
- [ ] Telegram отримує повідомлення при бронюванні

---

*Olka Studio v2.0 — Built with ❤️ for Hamilton, ON*
