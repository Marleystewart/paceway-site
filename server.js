const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const WAITLIST_FILE = path.join(__dirname, 'waitlist.json');

const APP_URL = (process.env.APP_URL || 'http://localhost:8083').replace(/\/$/, '');

// ── Google Sheets setup (optional — only runs if env vars are set) ──────────
let sheetsClient = null;
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  try {
    const { google } = require('googleapis');
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'null');
    if (!credentials) return null;
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    return sheetsClient;
  } catch (e) {
    console.warn('[sheets] setup failed:', e.message);
    return null;
  }
}

async function appendToSheet(type, row) {
  const sheets = await getSheetsClient();
  if (!sheets || !process.env.GOOGLE_SHEET_ID) return;
  const sheetName = type === 'club' ? 'Clubs' : type === 'rsvp' ? 'RSVPs' : 'Runners';
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${sheetName}!A:C`,
      valueInputOption: 'RAW',
      resource: { values: [row] },
    });
    console.log(`[sheets] appended to ${sheetName}`);
  } catch (e) {
    console.warn('[sheets] append failed:', e.message);
  }
}

// ── Resend email setup (optional — only runs if env var is set) ─────────────
async function sendConfirmationEmail(email, type) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const isClub = type === 'club';
    await resend.emails.send({
      from: 'Paceway <hello@joinpaceway.com>',
      to: email,
      subject: isClub
        ? "Thanks for your interest in Paceway 🏃"
        : "You're on the Paceway waitlist 🏃",
      html: isClub
        ? `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0A0A;color:#fff;border-radius:12px">
            <h2 style="color:#B4FF2E;margin-top:0">Thanks for reaching out.</h2>
            <p style="color:#aaa;line-height:1.6">We're building the platform run club culture has been waiting for — and we'd love to have <strong style="color:#fff">your club</strong> on it.</p>
            <p style="color:#aaa;line-height:1.6">We'll be in touch soon to learn more about your club and get you set up.</p>
            <p style="color:#aaa;line-height:1.6">— The Paceway Team</p>
          </div>`
        : `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0A0A0A;color:#fff;border-radius:12px">
            <h2 style="color:#B4FF2E;margin-top:0">You're in.</h2>
            <p style="color:#aaa;line-height:1.6">We'll let you know the moment Paceway launches in your city. In the meantime, <a href="https://joinpaceway.com/app" style="color:#B4FF2E">preview the app</a>.</p>
            <p style="color:#aaa;line-height:1.6">Running is the new going out — and your crew is waiting.</p>
            <p style="color:#aaa;line-height:1.6">— The Paceway Team</p>
          </div>`,
    });
    console.log(`[resend] confirmation sent → ${email}`);
  } catch (e) {
    console.warn('[resend] send failed:', e.message);
  }
}

// ── Init local JSON fallback ─────────────────────────────────────────────────
// Wrapped in try/catch: on Vercel the filesystem is read-only, so creating or
// migrating this file would throw at startup and crash every route (500). The
// waitlist is also backed up to Google Sheets, so a missing file is harmless.
try {
  if (!fs.existsSync(WAITLIST_FILE)) {
    fs.writeFileSync(WAITLIST_FILE, JSON.stringify({ runners: [], clubs: [] }, null, 2));
  } else {
    // Migrate old format { emails: [] } → { runners: [], clubs: [] }
    const data = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8'));
    if (data.emails && !data.runners) {
      data.runners = data.emails;
      data.clubs = [];
      delete data.emails;
      fs.writeFileSync(WAITLIST_FILE, JSON.stringify(data, null, 2));
    }
  }
} catch (e) {
  console.warn('[waitlist] init skipped (read-only fs):', e.message);
}

app.use(express.json());
app.use(express.static(__dirname));

// Club admin passwords — stored in CLUB_ADMIN_SECRETS env var as comma-separated values
const CLUB_SECRETS = new Set(
  (process.env.CLUB_ADMIN_SECRETS || '').split(',').map(s => s.trim()).filter(Boolean)
);
function isValidSecret(secret) {
  return secret && CLUB_SECRETS.has(secret);
}

// Where to email new-RSVP notifications, per club. Clubs without an email
// (e.g. ones that coordinate via GroupMe) just won't get the notify email —
// RSVPs are still saved and backed up to Google Sheets, and the runner is
// still emailed a confirmation.
const CLUB_NOTIFY_EMAILS = {
  'ny-flyers': 'info@nyflyers.org',
  'rat-race': 'ratracerunclubnj@gmail.com',
};

// ── Rate limiter ─────────────────────────────────────────────────────────────
const rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateMap.get(ip) || []).filter(t => now - t < 60_000);
  rateMap.set(ip, [...hits, now]);
  return hits.length >= 5;
}

// ── POST /api/waitlist ────────────────────────────────────────────────────────
app.post('/api/waitlist', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  }

  const { email, type = 'runner' } = req.body || {};
  const accountType = ['runner', 'club'].includes(type) ? type : 'runner';
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email || typeof email !== 'string' || !emailRegex.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const normalised = email.trim().toLowerCase();
  const joinedAt = new Date().toISOString();

  try {
    // ── Local JSON (backup / local dev) ──────────────────────────────────────
    let data = { runners: [], clubs: [] };
    try { data = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8')); } catch {}
    if (!data.runners) data.runners = [];
    if (!data.clubs) data.clubs = [];

    const allEmails = [...data.runners, ...data.clubs].map(e => e.email);
    if (allEmails.includes(normalised)) {
      return res.json({ success: true, message: "You're already on the list! We'll be in touch." });
    }

    const entry = { email: normalised, type: accountType, joinedAt };
    if (accountType === 'club') {
      data.clubs.push(entry);
    } else {
      data.runners.push(entry);
    }

    try { fs.writeFileSync(WAITLIST_FILE, JSON.stringify(data, null, 2)); } catch {}
    console.log(`[waitlist] +1 ${accountType} — ${normalised} (runners: ${data.runners.length}, clubs: ${data.clubs.length})`);

    // ── Google Sheets + email (await both so serverless doesn't kill them) ──────
    await Promise.allSettled([
      appendToSheet(accountType, [normalised, accountType, joinedAt]),
      sendConfirmationEmail(normalised, accountType),
    ]);

    const message = accountType === 'club'
      ? "Thanks! We'll reach out soon about getting your club listed. 🏃"
      : "You're on the list! We'll let you know when we launch in your city. 🏃";

    res.json({ success: true, message });
  } catch (err) {
    console.error('[waitlist] error:', err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

// ── GET /api/waitlist (admin) ─────────────────────────────────────────────────
app.get('/api/waitlist', (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8'));
    const runners = data.runners || [];
    const clubs = data.clubs || [];
    res.json({ total: runners.length + clubs.length, runners: runners.length, clubs: clubs.length, data });
  } catch {
    res.json({ total: 0, runners: 0, clubs: 0, data: { runners: [], clubs: [] } });
  }
});

// ── /app redirect ─────────────────────────────────────────────────────────────
app.get('/app', (req, res) => res.redirect(302, APP_URL + '/'));
app.get('/app/*', (req, res) => {
  const subPath = req.path.slice(4) || '/';
  res.redirect(302, APP_URL + subPath);
});

// ── Clubs data — in-memory store seeded from JSON ────────────────────────────
// Vercel filesystem is read-only; we load once and keep in memory.
// RSVPs are always emailed so no data is lost on cold restarts.
const CLUBS_FILE = path.join(__dirname, 'clubs-data.json');
let clubsMemory = null;
function getClubs() {
  if (!clubsMemory) {
    try { clubsMemory = JSON.parse(fs.readFileSync(CLUBS_FILE, 'utf8')); }
    catch { clubsMemory = {}; }
  }
  return clubsMemory;
}
function saveClubs(data) {
  clubsMemory = data; // memory only on Vercel; also try disk for local dev
  try { fs.writeFileSync(CLUBS_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ── GET club data (JSON) ──────────────────────────────────────────────────────
app.get('/api/clubs/:slug', (req, res) => {
  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });
  res.json(club);
});

// ── RSVP to event ─────────────────────────────────────────────────────────────
app.post('/api/clubs/:slug/events/:eventId/rsvp', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) return res.status(400).json({ error: 'Invalid email' });

  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });

  const event = club.events.find(e => e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  if (!event.rsvps) event.rsvps = [];
  const already = event.rsvps.find(r => r.email.toLowerCase() === email.trim().toLowerCase());
  if (already) return res.json({ success: true, message: "You're already on the list!", count: event.rsvps.length });

  const newRsvp = { name: name.trim(), email: email.trim().toLowerCase(), joinedAt: new Date().toISOString() };
  event.rsvps.push(newRsvp);
  saveClubs(clubs);
  // Back up RSVP to Google Sheets permanently
  appendToSheet('rsvp', [req.params.slug, event.title, newRsvp.name, newRsvp.email, newRsvp.joinedAt]).catch(() => {});

  // Email notification to club + confirmation to runner
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const clubName = club.name || 'your run club';
      const clubInsta = club.instagram;
      const notifyEmail = CLUB_NOTIFY_EMAILS[req.params.slug];

      const emails = [];
      // Notify the club (only if we have an address for them)
      if (notifyEmail) {
        emails.push(resend.emails.send({
          from: 'Paceway <hello@joinpaceway.com>',
          to: notifyEmail,
          subject: `New RSVP: ${name} is coming to ${event.title}`,
          html: `<div style="font-family:sans-serif;max-width:480px;padding:24px;background:#0A0A0A;color:#fff;border-radius:12px">
            <h2 style="color:#B4FF2E;margin-top:0">New RSVP 🏃</h2>
            <p style="color:#aaa"><strong style="color:#fff">${name}</strong> (${email}) just RSVPed to <strong style="color:#fff">${event.title}</strong> on ${event.day} at ${event.time}.</p>
            <p style="color:#aaa">Total RSVPs: <strong style="color:#fff">${event.rsvps.length}</strong></p>
            <p style="color:#555;font-size:12px">View all RSVPs: joinpaceway.com/clubs/${req.params.slug}/admin</p>
          </div>`
        }));
      }
      // Confirm to runner
      emails.push(resend.emails.send({
        from: 'Paceway <hello@joinpaceway.com>',
        to: email.trim(),
        subject: `You're in for ${event.title} 🏃`,
        html: `<div style="font-family:sans-serif;max-width:480px;padding:24px;background:#0A0A0A;color:#fff;border-radius:12px">
          <h2 style="color:#B4FF2E;margin-top:0">You're in!</h2>
          <p style="color:#aaa">See you at <strong style="color:#fff">${event.title}</strong> with ${clubName}.</p>
          <p style="color:#aaa">📅 ${event.day} · ${event.time}<br>📍 ${event.location}<br>👟 ${event.details}</p>
          ${clubInsta ? `<p style="color:#aaa">Check their Instagram <a href="https://instagram.com/${clubInsta}" style="color:#B4FF2E">@${clubInsta}</a> for the exact meet-up spot.</p>` : ''}
          <p style="color:#555;font-size:12px">Powered by Paceway · joinpaceway.com</p>
        </div>`
      }));
      await Promise.allSettled(emails);
    } catch(e) { console.warn('[resend] rsvp email failed:', e.message); }
  }

  res.json({ success: true, message: "You're in! Check your email for details.", count: event.rsvps.length });
});

// ── Admin: view RSVPs (password protected) ────────────────────────────────────
app.get('/api/clubs/:slug/rsvps', (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });
  res.json({ club: club.name, events: club.events.map(e => ({ ...e, rsvpCount: (e.rsvps||[]).length })) });
});

// ── Admin: update hero photo ──────────────────────────────────────────────────
app.patch('/api/clubs/:slug/hero', (req, res) => {
  if (!isValidSecret(req.body.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });
  club.heroPhoto = url;
  saveClubs(clubs);
  res.json({ success: true });
});

// ── Admin: update bio ─────────────────────────────────────────────────────────
app.patch('/api/clubs/:slug/bio', (req, res) => {
  if (!isValidSecret(req.body.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { bio } = req.body;
  if (bio === undefined) return res.status(400).json({ error: 'bio required' });
  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });
  club.bio = bio;
  saveClubs(clubs);
  res.json({ success: true });
});

// ── Admin: add photo ──────────────────────────────────────────────────────────
app.post('/api/clubs/:slug/photos', (req, res) => {
  if (!isValidSecret(req.body.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });
  if (!club.photos) club.photos = [];
  club.photos.push(url);
  saveClubs(clubs);
  res.json({ success: true, photos: club.photos });
});

// ── Admin: remove photo ───────────────────────────────────────────────────────
app.delete('/api/clubs/:slug/photos', (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const idx = parseInt(req.query.index);
  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });
  if (!isNaN(idx) && club.photos[idx] !== undefined) {
    club.photos.splice(idx, 1);
    saveClubs(clubs);
  }
  res.json({ success: true, photos: club.photos });
});

// ── Admin: add event ──────────────────────────────────────────────────────────
app.post('/api/clubs/:slug/events', (req, res) => {
  if (!isValidSecret(req.body.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { title, day, date, time, details, location, special } = req.body;
  if (!title || !date || !time) return res.status(400).json({ error: 'title, date, time required' });

  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });

  const newEvent = {
    id: 'evt-' + Date.now(),
    title, day: day || '', date, time,
    details: details || '', location: location || club.location,
    special: !!special,
    rsvps: []
  };
  club.events.push(newEvent);
  saveClubs(clubs);
  res.json({ success: true, event: newEvent });
});

// ── Admin: edit event ─────────────────────────────────────────────────────────
app.patch('/api/clubs/:slug/events/:eventId', (req, res) => {
  if (!isValidSecret(req.body.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });
  const event = club.events.find(e => e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const { title, date, time, details, location, special } = req.body;
  if (title) event.title = title;
  if (date) event.date = date;
  if (time) event.time = time;
  if (details !== undefined) event.details = details;
  if (location !== undefined) event.location = location;
  if (special !== undefined) event.special = !!special;
  saveClubs(clubs);
  res.json({ success: true, event });
});

// ── Admin: delete event ───────────────────────────────────────────────────────
app.delete('/api/clubs/:slug/events/:eventId', (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const clubs = getClubs();
  const club = clubs[req.params.slug];
  if (!club) return res.status(404).json({ error: 'Club not found' });
  club.events = club.events.filter(e => e.id !== req.params.eventId);
  saveClubs(clubs);
  res.json({ success: true });
});

// ── Club preview pages ────────────────────────────────────────────────────────
app.get('/clubs/:slug/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'club-admin.html'));
});

app.get('/clubs/:slug', (req, res) => {
  const file = path.join(__dirname, `club-${req.params.slug}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// ── Catch-all → landing page ──────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Paceway landing → http://localhost:${PORT}`);
  console.log(`Expo app        → ${APP_URL}`);
  console.log(`Waitlist admin  → http://localhost:${PORT}/api/waitlist?secret=YOUR_SECRET`);
});
