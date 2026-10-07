# ❄️ Winter Lock-In

A tiny web app (works great as a phone home-screen app) for a small crew to hold each other accountable.

- **Shared habits** (work out, read, sleep, eat healthy… add/remove your own): everyone ticks them daily, **3 pts** each.
- **Personal to-do lists**: each person's own list (optionally repeating daily), **1 pt** each. Everyone can see everyone's progress in the Crew tab.
- **Leaderboards**: points (last 7 days / all time), perfect-day streak, and a separate board per habit (current streak, best streak, total days).
- **Photo proof**: you can't tick anything off without a photo. Tap a ✅/📷 to see someone's proof; if it looks fake, hit **Call BS**. A single BS call from anyone flags it as **busted** and stops counting for points and streaks (redo it with a real photo).
- **Contesting**: if you think a BS call is wrong, hit *Contest*; the others vote Legit or Fake. It only clears if more people say Legit than Fake. Anyone who calls BS can change their mind by voting Legit.
- **Weekly schedule**: when you first join you set how many days a week you're committing to for each habit (say 5×/week for working out). The other days are rest days: skipping them doesn't break your streak (weeks run Mon–Sun). Later edits kick in the next Monday, so nobody can dodge a streak mid-week.
- **Feed** of everyone's proof photos, a **weekly winner** banner (last place picks the next challenge or buys coffee), **streak milestone** announcements in chat (7/14/21/30/50/75/100 days), and **final standings** when winter ends.
- **Chat** for the crew.
- Login = pick your name + one shared passcode. Max 4 people by default.

## Run locally

    LOCKIN_PASSCODE=somethingsecret npm start     # http://localhost:3000
    npm test

No dependencies, just Node 20+. Data is stored in `data/db.json`, photos in `data/proofs/` (photos are downscaled in the browser to ~1280px).

## Config (env vars)

| var | default | meaning |
|---|---|---|
| `LOCKIN_PASSCODE` | `winter` | shared passcode, **change it** |
| `TIMEZONE` | `America/New_York` | decides when "a new day" starts |
| `MAX_PLAYERS` | `4` | crew size |
| `DATA_DIR` | `./data` | where `db.json` lives (use a persistent disk when hosting; it holds the photos too) |
| `PHOTO_KEEP_DAYS` | `45` | proof photos older than this are deleted to save disk |
| `PORT` | `3000` | |

The end date (default March 20), the passcode, who's in the crew and a backup download are all in the app: tap your avatar for Settings.
The server also keeps a copy of the database each day in `data/backups/` (last 14).

## Hosting for your friends

It needs somewhere that runs Node with a persistent disk (Render, Fly.io, Railway…). On Render: new Web Service from this repo,
start command `npm start`, add a disk mounted at `/data`, and set `DATA_DIR=/data`, `LOCKIN_PASSCODE`, `TIMEZONE`.
Then everyone opens the URL and uses *Share → Add to Home Screen*.

## Rules

- You can edit today and yesterday (grace for forgetting).
- Streaks: today not being done yet doesn't break your streak; a fully missed day does.
- Removing a shared habit keeps past points and streaks, but it no longer counts toward perfect days.
