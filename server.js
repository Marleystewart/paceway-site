const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const WAITLIST_FILE = path.join(__dirname, 'waitlist.json');

// URL of the Expo web app.
//   Local dev:  defaults to the Expo Metro dev server on 8083
//   Production: set APP_URL=https://app.joinpaceway.com in Vercel env vars
const APP_URL = (process.env.APP_URL || 'http://localhost:8083').replace(/\/$/, '');

// Init waitlist file
if (!fs.existsSync(WAITLIST_FILE)) {
  fs.writeFileSync(WAITLIST_FILE, JSON.stringify({ emails: [] }, null, 2));
}

app.use(express.json());
app.use(express.static(__dirname));

// Simple in-memory rate limiter (IP → timestamp[])
const rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateMap.get(ip) || []).filter(t => now - t < 60_000);
  rateMap.set(ip, [...hits, now]);
  return hits.length >= 5; // 5 submissions per minute per IP
}

// POST /api/waitlist — store email
app.post('/api/waitlist', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  }

  const { email } = req.body || {};
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email || typeof email !== 'string' || !emailRegex.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const normalised = email.trim().toLowerCase();

  try {
    const data = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8'));

    if (data.emails.some(e => e.email === normalised)) {
      return res.json({ success: true, message: "You're already on the list! We'll be in touch." });
    }

    data.emails.push({ email: normalised, joinedAt: new Date().toISOString() });
    fs.writeFileSync(WAITLIST_FILE, JSON.stringify(data, null, 2));
    console.log(`[waitlist] +1 — ${normalised} (total: ${data.emails.length})`);

    res.json({ success: true, message: "You're on the list! We'll reach out soon. 🏃" });
  } catch (err) {
    console.error('[waitlist] error:', err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

// GET /api/waitlist — view list (protect with ADMIN_SECRET env var)
app.get('/api/waitlist', (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const data = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8'));
  res.json({ count: data.emails.length, emails: data.emails });
});

// /app and /app/* — redirect to the Expo web app
// Local:      redirects to http://localhost:8083
// Production: redirects to https://app.joinpaceway.com (set APP_URL env var)
app.get('/app', (req, res) => {
  res.redirect(302, APP_URL + '/');
});

app.get('/app/*', (req, res) => {
  const subPath = req.path.slice(4) || '/'; // strip leading /app
  res.redirect(302, APP_URL + subPath);
});

// Catch-all → landing page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Paceway landing → http://localhost:${PORT}`);
  console.log(`Expo app        → ${APP_URL} (or via /app redirect)`);
  console.log(`Waitlist admin  → http://localhost:${PORT}/api/waitlist?secret=YOUR_SECRET`);
});
