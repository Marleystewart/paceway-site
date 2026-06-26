# Paceway — Handoff

Project: `/Users/marley/paceway/` — Express landing site + club profile pages → joinpaceway.com
Deploy: `npx vercel --prod` from that folder, then `git push origin main`
Repo: github.com/Marleystewart/paceway-site (public; Trey/treytasku is a collaborator)
Vercel project: paceway (Hobby plan)

## Key files

- `server.js` — API (clubs, RSVP, follow, photo upload), admin auth
- `clubs-data.json` — all club data (name, bio, events, photos, etc.)
- `club-<slug>.html` — each club's public page
- `club-admin.html` — shared admin dashboard
- `index.html` — landing page (has scroll-reveal animations)
- Admin passwords (env var `CLUB_ADMIN_SECRETS` on Vercel): ratrace2026, nyflyers2026, rcf2026, florecitas2026, arc2026

Live full clubs (admin + RSVP + follow): rat-race, ny-flyers, rcf, florecitas, arc
Preview-only mocks (no admin): pumas, running-latte (latte), eo, eyd, frc, rcct, ace, rwc, sinfrenos, hustle

URL pattern: `joinpaceway.com/clubs/<slug>` and `/clubs/<slug>/admin`

## How things work

- Vercel is read-only → club data is in-memory, seeded from `clubs-data.json`, RSVPs/followers backed up to Google Sheets + emailed (Resend)
- Photo uploads: clubs upload from device → Vercel Blob (public store `paceway-photos`, token `BLOB_READ_WRITE_TOKEN`). Pasting Instagram URLs does NOT work (they expire) — uploads are the fix.
- Custom SVG headers exist for arc, rwc, sinfrenos (`<slug>-hero.svg`); `.svg` is whitelisted in `vercel.json`
- Profile pics editable in admin (`avatarPhoto`, renders on all live pages)
- Image files: spaces break URLs — always rename (e.g. `arc-1.jpeg`)

## Gotchas

- Git auto-deploy is OFF (it broke the site once via a read-only-fs crash — now fixed, but kept off). Deploy via CLI.
- Always `git fetch && git pull --rebase` before pushing (Trey may have pushed).

## Open items

- Florecitas admin asked to edit more fields (club name, location, stat boxes) — not built yet
- Trey works in paceway-site independently now
