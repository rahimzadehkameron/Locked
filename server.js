import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  addDays, buildBoards, habitActiveOn, isBusted, mondayOf, pointsBetween, targetOn, taskActiveOn,
} from "./scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PASSCODE = process.env.LOCKIN_PASSCODE || "winter";
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 4);
const TIMEZONE = process.env.TIMEZONE || "America/New_York";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const PROOF_DIR = path.join(DATA_DIR, "proofs");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_PROOF_BYTES = 4_000_000;
const PHOTO_KEEP_DAYS = Number(process.env.PHOTO_KEEP_DAYS || 45);
const MILESTONES = [7, 14, 21, 30, 50, 75, 100];
const COLORS = ["#7dd3fc", "#f9a8d4", "#fcd34d", "#86efac", "#c4b5fd", "#fdba74"];

const uid = () => crypto.randomBytes(6).toString("hex");
const todayStr = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());

// ---------- persistence ----------
function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    const t = todayStr();
    const y = Number(t.slice(0, 4));
    // Winter ends on the next March 20th unless the crew changes it.
    const endDate = `${t > `${y}-03-20` ? y + 1 : y}-03-20`;
    const mk = (name, emoji) => ({ id: uid(), name, emoji, createdDate: t, archivedDate: null });
    return {
      startDate: t,
      endDate,
      passcode: null,
      schedules: {},
      milestones: {},
      players: [],
      sessions: {},
      habits: [
        mk("Work out", "🏋️"),
        mk("Read", "📚"),
        mk("Sleep 8 hours", "😴"),
        mk("Eat healthy", "🥗"),
      ],
      habitChecks: {},
      tasks: [],
      taskChecks: {},
      messages: [],
    };
  }
}
const db = load();
db.schedules ||= {};
db.milestones ||= {};
db.endDate ||= `${Number(db.startDate.slice(0, 4)) + 1}-03-20`;
let saveTimer = null;
let lastBackup = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
    backupDaily();
  }, 50);
}

// One copy of the database per day, keeping the last 14.
function backupDaily() {
  const day = todayStr();
  if (lastBackup === day) return;
  lastBackup = day;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `db-${day}.json`));
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("db-")).sort().slice(0, -14);
    for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f));
  } catch (e) {
    console.error("backup failed", e);
  }
}

// Photos older than PHOTO_KEEP_DAYS are deleted to keep the disk from filling up.
function sweepPhotos() {
  try {
    const cutoff = Date.now() - PHOTO_KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(PROOF_DIR)) {
      const file = path.join(PROOF_DIR, f);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file);
    }
  } catch {
    /* no photos yet */
  }
}
process.on("SIGTERM", () => {
  if (saveTimer) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  }
  process.exit(0);
});

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const clean = (s, max) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, max);

const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString("hex");
function passcodeOk(input) {
  if (!db.passcode) return safeEqual(input ?? "", PASSCODE);
  return safeEqual(hashPass(input ?? "", db.passcode.salt), db.passcode.hash);
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Only today and yesterday can be edited (grace for forgetting to tick).
function checkDate(date) {
  const t = todayStr();
  if (t > db.endDate) throw new HttpError(400, "Winter's over, the final standings are locked");
  if (date !== t && date !== addDays(t, -1)) throw new HttpError(400, "You can only edit today or yesterday");
  return date;
}

// A check counts unless the crew has busted it.
const counts = (check) => !!check && !isBusted(check);

function* proofChecks() {
  for (const [key, check] of Object.entries(db.habitChecks)) {
    if (typeof check !== "object") continue;
    const [date, refId, playerId] = key.split("|");
    yield { kind: "habit", date, refId, playerId, check };
  }
  const owner = new Map(db.tasks.map((t) => [t.id, t.playerId]));
  for (const [key, check] of Object.entries(db.taskChecks)) {
    if (typeof check !== "object") continue;
    const [date, refId] = key.split("|");
    yield { kind: "task", date, refId, playerId: owner.get(refId), check };
  }
}

function labelFor(kind, refId) {
  if (kind === "habit") {
    const h = db.habits.find((x) => x.id === refId);
    return h ? `${h.emoji} ${h.name}` : "habit";
  }
  return db.tasks.find((t) => t.id === refId)?.text || "task";
}

const proofView = ({ kind, date, refId, playerId, check }) => ({
  kind, date, refId, playerId,
  proofId: check.proof,
  ts: check.ts,
  label: labelFor(kind, refId),
  calls: Object.entries(check.calls || {}).map(([id, v]) => ({ id, reason: v?.reason || "" })),
  legit: Object.keys(check.legit || {}),
  contest: check.contest || null,
  busted: isBusted(check),
});

const proofsFor = (dates) => [...proofChecks()].filter((c) => dates.includes(c.date)).map(proofView);

function say(text) {
  db.messages.push({ id: uid(), system: true, text, ts: Date.now() });
  if (db.messages.length > 1000) db.messages.splice(0, db.messages.length - 1000);
}

// Post a chat message when someone reaches a new streak milestone.
function announceMilestones(player) {
  const b = buildBoards(db, todayStr());
  const items = [
    { key: "perfect", label: "perfect-day", cur: b.perfect.find((r) => r.playerId === player.id)?.current ?? 0 },
    ...b.habits.map((hb) => ({
      key: hb.habitId,
      label: db.habits.find((h) => h.id === hb.habitId)?.name ?? "habit",
      cur: hb.rows.find((r) => r.playerId === player.id)?.current ?? 0,
    })),
  ];
  for (const { key, label, cur } of items) {
    let fresh = 0;
    for (const m of MILESTONES) {
      const k = `${player.id}|${key}|${m}`;
      if (cur >= m) {
        if (!db.milestones[k]) fresh = m;
        db.milestones[k] = 1;
      } else delete db.milestones[k]; // streak was reset, so it can be announced again
    }
    if (fresh) say(`🔥 ${player.name} hit a ${fresh}-day ${label} streak!`);
  }
}

function stateFor(me) {
  const today = todayStr();
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const sharedToday = {};
  for (const h of db.habits) {
    if (h.archivedDate) continue;
    sharedToday[h.id] = db.players
      .filter((p) => counts(db.habitChecks[`${today}|${h.id}|${p.id}`]))
      .map((p) => p.id);
  }
  const tasksFor = (date) =>
    db.tasks
      .filter((t) => taskActiveOn(t, date))
      .map((t) => ({
        id: t.id,
        playerId: t.playerId,
        text: t.text,
        daily: t.daily,
        done: counts(db.taskChecks[`${date}|${t.id}`]),
      }));
  const myChecks = {}; // date -> habitIds done by me (for yesterday catch-up + week strip)
  for (const d of weekDays) {
    myChecks[d] = db.habits
      .filter((h) => counts(db.habitChecks[`${d}|${h.id}|${me.id}`]))
      .map((h) => h.id);
  }
  const monday = mondayOf(today);
  const weekProgress = {};
  const schedule = {};
  for (const h of db.habits) {
    if (h.archivedDate) continue;
    const entries = db.schedules[me.id]?.[h.id] || [];
    let done = 0;
    for (let d = monday; d <= today; d = addDays(d, 1)) if (counts(db.habitChecks[`${d}|${h.id}|${me.id}`])) done++;
    const target = targetOn(entries, today);
    weekProgress[h.id] = { done, target };
    const pending = entries.filter((e) => e.from > today).pop();
    schedule[h.id] = { days: target, next: pending ? pending.days : null };
  }
  const boards = buildBoards(db, today);
  const lastEnd = addDays(monday, -1);
  const lastRows = pointsBetween(db, addDays(lastEnd, -6), lastEnd).sort((a, b) => b.points - a.points);
  const over = today > db.endDate;
  const photos = new Map();
  for (const c of proofChecks()) if (!isBusted(c.check)) photos.set(c.playerId, (photos.get(c.playerId) || 0) + 1);
  return {
    today,
    endDate: db.endDate,
    meScheduled: !!me.scheduled,
    weekProgress,
    schedule,
    lastWeek: lastEnd >= db.startDate && lastRows.some((r) => r.points) ? { start: addDays(lastEnd, -6), end: lastEnd, rows: lastRows } : null,
    final: over
      ? {
          points: [...boards.points].sort((a, b) => b.total - a.total),
          bestStreak: [...boards.perfect].sort((a, b) => b.best - a.best)[0] || null,
          photos: db.players.map((p) => ({ playerId: p.id, count: photos.get(p.id) || 0 })),
        }
      : null,
    yesterday: addDays(today, -1),
    startDate: db.startDate,
    me: me.id,
    maxPlayers: MAX_PLAYERS,
    players: db.players,
    habits: db.habits.filter((h) => !h.archivedDate),
    sharedToday,
    myChecks,
    weekDays,
    habitsActive: Object.fromEntries(
      weekDays.map((d) => [d, db.habits.filter((h) => habitActiveOn(h, d)).map((h) => h.id)]),
    ),
    tasks: { [today]: tasksFor(today), [addDays(today, -1)]: tasksFor(addDays(today, -1)) },
    proofs: proofsFor([today, addDays(today, -1)]),
    boards,
    messages: db.messages.slice(-150),
  };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, { auth = true, raw = false } = {}) =>
  routes.push({ method, re: new RegExp(`^${pattern}$`), handler, auth, raw });

route(
  "POST",
  "/api/login",
  (req, body) => {
    if (!passcodeOk(body.passcode)) throw new HttpError(401, "Wrong passcode");
    let player;
    if (body.playerId) {
      player = db.players.find((p) => p.id === body.playerId);
      if (!player) throw new HttpError(404, "Unknown player");
    } else {
      const name = clean(body.newName, 20);
      if (!name) throw new HttpError(400, "Enter a name");
      if (db.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
        throw new HttpError(409, "That name is taken");
      if (db.players.length >= MAX_PLAYERS) throw new HttpError(403, "The crew is full");
      const color = COLORS.find((c) => !db.players.some((p) => p.color === c)) || COLORS[0];
      player = { id: uid(), name, color, joined: todayStr(), scheduled: false };
      db.players.push(player);
    }
    const token = crypto.randomBytes(24).toString("hex");
    db.sessions[token] = player.id;
    save();
    return { token, playerId: player.id };
  },
  { auth: false },
);

route(
  "GET",
  "/api/players",
  () => ({ players: db.players, maxPlayers: MAX_PLAYERS }),
  { auth: false },
);

route("GET", "/api/state", (req, body, me) => stateFor(me));

// Ticking something off needs a photo (see POST /api/proof); this only un-ticks.
function uncheck(store, key) {
  const old = store[key];
  if (old?.proof) fs.rm(path.join(PROOF_DIR, `${old.proof}.jpg`), () => {});
  delete store[key];
}
const requireUncheck = (body) => {
  if (body.done) throw new HttpError(400, "Upload a photo to check this off");
};

route("POST", "/api/habit-check", (req, body, me) => {
  requireUncheck(body);
  const habit = db.habits.find((h) => h.id === body.habitId && !h.archivedDate);
  if (!habit) throw new HttpError(404, "No such habit");
  uncheck(db.habitChecks, `${checkDate(body.date)}|${habit.id}|${me.id}`);
  save();
  return stateFor(me);
});

// Resolve which check store/key a proof upload or call-out refers to.
function checkTarget(kind, id, date, ownerId) {
  date = checkDate(date);
  if (kind === "habit") {
    const habit = db.habits.find((h) => h.id === id && !h.archivedDate);
    if (!habit || !habitActiveOn(habit, date)) throw new HttpError(404, "No such habit");
    return { store: db.habitChecks, key: `${date}|${habit.id}|${ownerId}` };
  }
  if (kind === "task") {
    const task = db.tasks.find((t) => t.id === id);
    if (!task || !taskActiveOn(task, date)) throw new HttpError(404, "No such task");
    if (task.playerId !== ownerId) throw new HttpError(404, "No such task");
    return { store: db.taskChecks, key: `${date}|${task.id}` };
  }
  throw new HttpError(400, "Bad kind");
}

route(
  "POST",
  "/api/proof",
  (req, buf, me) => {
    const q = new URL(req.url, "http://x").searchParams;
    const { store, key } = checkTarget(q.get("kind"), q.get("id"), q.get("date"), me.id);
    if (!buf.length) throw new HttpError(400, "No photo received");
    if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw new HttpError(400, "Photo must be a JPEG");
    const proof = crypto.randomBytes(8).toString("hex");
    fs.mkdirSync(PROOF_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROOF_DIR, `${proof}.jpg`), buf);
    uncheck(store, key); // replacing a photo also clears old call-outs
    store[key] = { proof, ts: Date.now(), calls: {} };
    announceMilestones(me);
    save();
    return stateFor(me);
  },
  { raw: true },
);

route("GET", "/api/proof/([a-f0-9]{16})", (req, body, me, [id]) => {
  try {
    return { raw: fs.readFileSync(path.join(PROOF_DIR, `${id}.jpg`)), type: "image/jpeg" };
  } catch {
    throw new HttpError(404, "Photo not found");
  }
});

// Drop a dispute once nobody is calling BS any more.
function tidy(check) {
  if (!Object.keys(check.calls || {}).length) {
    delete check.contest;
    check.legit = {};
  }
}

function targetCheck(body, me) {
  if (body.ownerId === me.id) throw new HttpError(400, "That's your own proof");
  if (!db.players.some((p) => p.id === body.ownerId)) throw new HttpError(404, "Unknown player");
  const { store, key } = checkTarget(body.kind, body.id, body.date, body.ownerId);
  const check = store[key];
  if (!check || typeof check !== "object") throw new HttpError(404, "No photo to review");
  check.calls ||= {};
  check.legit ||= {};
  return check;
}

// Call BS on someone's proof (or take the call back). One call is enough to flag it.
route("POST", "/api/call-out", (req, body, me) => {
  const check = targetCheck(body, me);
  if (body.on) {
    const reason = clean(body.reason, 100);
    check.calls[me.id] = { ts: Date.now(), reason };
    delete check.legit[me.id];
    const owner = db.players.find((p) => p.id === body.ownerId);
    say(`🚨 ${me.name} called BS on ${owner.name}'s ${labelFor(body.kind, body.id)}${reason ? `: "${reason}"` : ""}`);
  } else delete check.calls[me.id];
  tidy(check);
  save();
  return stateFor(me);
});

// The owner disputes a BS call. The others then vote and it only clears if more say "legit" than "fake".
route("POST", "/api/contest", (req, body, me) => {
  const { store, key } = checkTarget(body.kind, body.id, body.date, me.id);
  const check = store[key];
  if (!check || typeof check !== "object" || !isBusted(check)) throw new HttpError(400, "Nothing to contest");
  if (check.contest) throw new HttpError(400, "Already contested");
  const note = clean(body.note, 140);
  check.contest = { ts: Date.now(), note };
  check.legit = {};
  say(`⚖️ ${me.name} is contesting the BS on their ${labelFor(body.kind, body.id)}${note ? `: "${note}"` : ""}. Vote on it!`);
  save();
  return stateFor(me);
});

route("POST", "/api/vote", (req, body, me) => {
  const check = targetCheck(body, me);
  if (!check.contest) throw new HttpError(400, "Nobody has contested this");
  if (body.vote === "legit") {
    check.legit[me.id] = Date.now();
    delete check.calls[me.id];
  } else if (body.vote === "fake") {
    check.calls[me.id] = { ts: Date.now(), reason: "voted fake" };
    delete check.legit[me.id];
  } else throw new HttpError(400, "Vote legit or fake");
  tidy(check);
  save();
  return stateFor(me);
});

// Everyone's proof photos, newest first.
route("GET", "/api/feed", (req) => {
  const limit = Math.min(60, Number(new URL(req.url, "http://x").searchParams.get("limit")) || 24);
  const items = [...proofChecks()].map(proofView).sort((a, b) => b.ts - a.ts);
  return { items: items.slice(0, limit), more: items.length > limit };
});

// How many days a week each habit is expected. First time applies now; later edits start next Monday.
route("POST", "/api/schedule", (req, body, me) => {
  const first = !me.scheduled;
  const from = addDays(mondayOf(todayStr()), 7);
  for (const h of db.habits.filter((x) => !x.archivedDate)) {
    const days = Math.round(Number(body.days?.[h.id] ?? 7));
    if (!(days >= 1 && days <= 7)) throw new HttpError(400, "Pick 1 to 7 days a week");
    db.schedules[me.id] ||= {};
    const entries = (db.schedules[me.id][h.id] || []).filter((e) => e.from < from);
    if (first) db.schedules[me.id][h.id] = [{ from: "0000-00-00", days }];
    else {
      entries.push({ from, days });
      db.schedules[me.id][h.id] = entries;
    }
  }
  me.scheduled = true;
  save();
  return stateFor(me);
});

route("POST", "/api/settings", (req, body, me) => {
  if (body.endDate !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.endDate) || Number.isNaN(Date.parse(body.endDate)))
      throw new HttpError(400, "Pick a valid end date");
    if (body.endDate < db.startDate) throw new HttpError(400, "That's before the lock-in started");
    db.endDate = body.endDate;
  }
  save();
  return stateFor(me);
});

route("POST", "/api/passcode", (req, body, me) => {
  if (!passcodeOk(body.current)) throw new HttpError(401, "Current passcode is wrong");
  const next = String(body.next ?? "");
  if (next.length < 4) throw new HttpError(400, "Use at least 4 characters");
  const salt = crypto.randomBytes(8).toString("hex");
  db.passcode = { salt, hash: hashPass(next, salt) };
  save();
  return stateFor(me);
});

// Remove a player and everything they did (their photos too).
route("DELETE", "/api/players/([a-f0-9]+)", (req, body, me, [id]) => {
  if (id === me.id) throw new HttpError(400, "You can't remove yourself");
  const gone = db.players.find((p) => p.id === id);
  if (!gone) throw new HttpError(404, "Unknown player");
  const dropPhoto = (check) => check?.proof && fs.rm(path.join(PROOF_DIR, `${check.proof}.jpg`), () => {});
  for (const [key, check] of Object.entries(db.habitChecks)) {
    if (!key.endsWith(`|${id}`)) continue;
    dropPhoto(check);
    delete db.habitChecks[key];
  }
  const mine = new Set(db.tasks.filter((t) => t.playerId === id).map((t) => t.id));
  for (const [key, check] of Object.entries(db.taskChecks)) {
    if (!mine.has(key.split("|")[1])) continue;
    dropPhoto(check);
    delete db.taskChecks[key];
  }
  db.tasks = db.tasks.filter((t) => t.playerId !== id);
  for (const check of [...Object.values(db.habitChecks), ...Object.values(db.taskChecks)]) {
    if (typeof check !== "object") continue;
    delete check.calls?.[id];
    delete check.legit?.[id];
    tidy(check);
  }
  for (const t of Object.keys(db.sessions)) if (db.sessions[t] === id) delete db.sessions[t];
  db.players = db.players.filter((p) => p.id !== id);
  delete db.schedules[id];
  for (const k of Object.keys(db.milestones)) if (k.startsWith(`${id}|`)) delete db.milestones[k];
  say(`${gone.name} left the lock-in.`);
  save();
  return stateFor(me);
});

route("GET", "/api/export", () => {
  const { sessions: _s, passcode: _p, ...rest } = db; // never export login tokens or the passcode
  return { raw: Buffer.from(JSON.stringify(rest, null, 2)), type: "application/json", filename: `lockin-backup-${todayStr()}.json` };
});

route("POST", "/api/habits", (req, body, me) => {
  const name = clean(body.name, 30);
  if (!name) throw new HttpError(400, "Name required");
  if (db.habits.filter((h) => !h.archivedDate).length >= 12) throw new HttpError(400, "Too many shared habits");
  db.habits.push({
    id: uid(),
    name,
    emoji: clean(body.emoji, 4) || "⭐",
    createdDate: todayStr(),
    archivedDate: null,
  });
  save();
  return stateFor(me);
});

route("DELETE", "/api/habits/([a-f0-9]+)", (req, body, me, [id]) => {
  const habit = db.habits.find((h) => h.id === id && !h.archivedDate);
  if (!habit) throw new HttpError(404, "No such habit");
  habit.archivedDate = todayStr(); // history & points are kept
  save();
  return stateFor(me);
});

route("POST", "/api/tasks", (req, body, me) => {
  const text = clean(body.text, 80);
  if (!text) throw new HttpError(400, "Text required");
  if (db.tasks.filter((t) => t.playerId === me.id && !t.archivedDate).length >= 30)
    throw new HttpError(400, "Too many tasks");
  db.tasks.push({
    id: uid(),
    playerId: me.id,
    text,
    daily: !!body.daily,
    createdDate: todayStr(),
    archivedDate: null,
  });
  save();
  return stateFor(me);
});

route("POST", "/api/task-check", (req, body, me) => {
  requireUncheck(body);
  const date = checkDate(body.date);
  const task = db.tasks.find((t) => t.id === body.taskId);
  if (!task || task.playerId !== me.id) throw new HttpError(404, "No such task");
  uncheck(db.taskChecks, `${date}|${task.id}`);
  save();
  return stateFor(me);
});

route("DELETE", "/api/tasks/([a-f0-9]+)", (req, body, me, [id]) => {
  const task = db.tasks.find((t) => t.id === id && t.playerId === me.id && !t.archivedDate);
  if (!task) throw new HttpError(404, "No such task");
  // Daily tasks stop appearing from today; one-offs are hidden on their own day.
  task.archivedDate = task.daily ? todayStr() : task.createdDate;
  save();
  return stateFor(me);
});

route("POST", "/api/messages", (req, body, me) => {
  const text = clean(body.text, 500);
  if (!text) throw new HttpError(400, "Message is empty");
  db.messages.push({ id: uid(), playerId: me.id, text, ts: Date.now() });
  if (db.messages.length > 1000) db.messages.splice(0, db.messages.length - 1000);
  save();
  return stateFor(me);
});

// ---------- server ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function readBody(req, { raw = false } = {}) {
  const limit = raw ? MAX_PROOF_BYTES : 50_000;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (raw) return resolve(Buffer.concat(chunks));
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

export const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  if (!pathname.startsWith("/api/")) return serveStatic(req, res);
  try {
    for (const r of routes) {
      const m = pathname.match(r.re);
      if (r.method !== req.method || !m) continue;
      let me = null;
      if (r.auth) {
        const token = (req.headers.authorization || "").replace(/^Bearer /, "");
        me = db.players.find((p) => p.id === db.sessions[token]);
        if (!me) throw new HttpError(401, "Please log in again");
      }
      const body = req.method === "GET" ? {} : await readBody(req, { raw: r.raw });
      const out = r.handler(req, body, me, m.slice(1));
      if (out?.raw) {
        res.writeHead(200, {
          "Content-Type": out.type,
          "Cache-Control": out.filename ? "no-store" : "private, max-age=86400",
          ...(out.filename ? { "Content-Disposition": `attachment; filename="${out.filename}"` } : {}),
        });
        return res.end(out.raw);
      }
      return sendJson(res, 200, out);
    }
    throw new HttpError(404, "Not found");
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: "Server error" });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sweepPhotos();
  setInterval(sweepPhotos, 6 * 3600 * 1000).unref();
  server.listen(PORT, () => {
    console.log(`Winter Lock-In running on :${PORT} (passcode "${PASSCODE}", tz ${TIMEZONE})`);
    if (!process.env.LOCKIN_PASSCODE) console.log("Set LOCKIN_PASSCODE to change the default passcode.");
  });
}
