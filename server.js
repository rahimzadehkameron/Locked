import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { addDays, buildBoards, habitActiveOn, isBusted, taskActiveOn } from "./scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PASSCODE = process.env.LOCKIN_PASSCODE || "winter";
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 4);
const TIMEZONE = process.env.TIMEZONE || "America/New_York";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const PROOF_DIR = path.join(DATA_DIR, "proofs");
const MAX_PROOF_BYTES = 4_000_000;
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
    const mk = (name, emoji) => ({ id: uid(), name, emoji, createdDate: t, archivedDate: null });
    return {
      startDate: t,
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
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 50);
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

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Only today and yesterday can be edited (grace for forgetting to tick).
function checkDate(date) {
  const t = todayStr();
  if (date !== t && date !== addDays(t, -1)) throw new HttpError(400, "You can only edit today or yesterday");
  return date;
}

// A check counts unless the crew has busted it.
const counts = (check) => !!check && !isBusted(check);

function proofsFor(dates) {
  const out = [];
  const add = (store, kind, keyToRef) => {
    for (const [key, check] of Object.entries(store)) {
      if (typeof check !== "object" || !dates.includes(key.split("|")[0])) continue;
      const { date, refId, playerId } = keyToRef(key.split("|"));
      out.push({
        date, kind, refId, playerId,
        proofId: check.proof,
        ts: check.ts,
        calls: Object.keys(check.calls || {}),
        busted: isBusted(check),
      });
    }
  };
  add(db.habitChecks, "habit", ([date, refId, playerId]) => ({ date, refId, playerId }));
  const owner = new Map(db.tasks.map((t) => [t.id, t.playerId]));
  add(db.taskChecks, "task", ([date, refId]) => ({ date, refId, playerId: owner.get(refId) }));
  return out;
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
  return {
    today,
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
    boards: buildBoards(db, today),
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
    if (!safeEqual(body.passcode ?? "", PASSCODE)) throw new HttpError(401, "Wrong passcode");
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
      player = { id: uid(), name, color: COLORS[db.players.length % COLORS.length] };
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

// Call BS on someone's proof (or take the call back).
route("POST", "/api/call-out", (req, body, me) => {
  if (body.ownerId === me.id) throw new HttpError(400, "You can't call yourself out");
  if (!db.players.some((p) => p.id === body.ownerId)) throw new HttpError(404, "Unknown player");
  const { store, key } = checkTarget(body.kind, body.id, body.date, body.ownerId);
  const check = store[key];
  if (!check || typeof check !== "object") throw new HttpError(404, "Nothing to call out");
  check.calls ||= {};
  if (body.on) check.calls[me.id] = Date.now();
  else delete check.calls[me.id];
  save();
  return stateFor(me);
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
        res.writeHead(200, { "Content-Type": out.type, "Cache-Control": "private, max-age=86400" });
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
  server.listen(PORT, () => {
    console.log(`Winter Lock-In running on :${PORT} (passcode "${PASSCODE}", tz ${TIMEZONE})`);
    if (!process.env.LOCKIN_PASSCODE) console.log("Set LOCKIN_PASSCODE to change the default passcode.");
  });
}
