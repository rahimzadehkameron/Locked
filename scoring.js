// Pure scoring helpers (no I/O) so they can be unit tested.

export const SHARED_POINTS = 3;
export const PERSONAL_POINTS = 1;

const DAY_MS = 86400000;

export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the week containing `date` (weeks run Mon–Sun). */
export function mondayOf(date) {
  const dow = (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

/**
 * A check is either 1 (legacy, no proof) or
 * { proof, ts, calls: {playerId: {ts, reason}}, legit: {playerId: ts}, contest?: {ts, note} }.
 * Any BS call busts it. If the owner contests, the other players vote and it
 * only clears when strictly more of them say "legit" than "fake".
 */
export function isBusted(check) {
  if (!check || typeof check !== "object") return false;
  const fake = Object.keys(check.calls || {}).length;
  if (!fake) return false;
  if (!check.contest) return true;
  return !(Object.keys(check.legit || {}).length > fake);
}

export function habitActiveOn(h, date) {
  return h.createdDate <= date && (!h.archivedDate || date < h.archivedDate);
}

export function taskActiveOn(t, date) {
  if (!t.daily && t.createdDate !== date) return false;
  return t.createdDate <= date && (!t.archivedDate || date < t.archivedDate);
}

/** Days per week a player committed to for a habit on `date` (7 if never set). */
export function targetOn(entries, date) {
  let days = 7;
  for (const e of entries || []) if (e.from <= date) days = e.days;
  return days;
}

/**
 * Per-day status for one player and one habit: 'done', 'rest' (a miss covered by
 * the player's weekly schedule) or 'miss' (breaks the streak). Today is left out
 * until it's done, since the day isn't over.
 */
export function habitStates(doneSet, entries, start, today) {
  const states = new Map();
  let week = null;
  let misses = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const wk = mondayOf(d);
    if (wk !== week) {
      week = wk;
      misses = 0;
    }
    if (doneSet.has(d)) {
      states.set(d, "done");
      continue;
    }
    if (d === today) continue;
    misses++;
    states.set(d, misses <= 7 - targetOn(entries, d) ? "rest" : "miss");
  }
  return states;
}

/** Streak numbers from a date->status map. Rest days keep a streak alive but don't add to it. */
export function streakFromStates(states, today) {
  let current = 0;
  let cursor = states.has(today) ? today : addDays(today, -1);
  for (;;) {
    const s = states.get(cursor);
    if (!s || s === "miss") break;
    if (s === "done") current++;
    cursor = addDays(cursor, -1);
  }
  let best = 0;
  let run = 0;
  let total = 0;
  for (const s of states.values()) {
    if (s === "miss") run = 0;
    else if (s === "done") {
      run++;
      total++;
      if (run > best) best = run;
    }
  }
  return { current, best, total };
}

/** Every counted (non-busted) check as { kind, date, playerId, habitId|taskId }. */
function* countedChecks(db) {
  for (const [key, check] of Object.entries(db.habitChecks)) {
    if (isBusted(check)) continue;
    const [date, habitId, playerId] = key.split("|");
    yield { kind: "habit", date, playerId, habitId };
  }
  const owner = new Map(db.tasks.map((t) => [t.id, t.playerId]));
  for (const [key, check] of Object.entries(db.taskChecks)) {
    if (isBusted(check)) continue;
    const [date, taskId] = key.split("|");
    yield { kind: "task", date, playerId: owner.get(taskId), taskId };
  }
}

/** Points per player for checks dated within [start, end]. */
export function pointsBetween(db, start, end) {
  const pts = new Map(db.players.map((p) => [p.id, 0]));
  for (const c of countedChecks(db)) {
    if (c.date < start || c.date > end || !pts.has(c.playerId)) continue;
    pts.set(c.playerId, pts.get(c.playerId) + (c.kind === "habit" ? SHARED_POINTS : PERSONAL_POINTS));
  }
  return [...pts].map(([playerId, points]) => ({ playerId, points }));
}

/**
 * Build leaderboard data.
 * db: { players, habits, schedules: {playerId: {habitId: [{from, days}]}}, startDate,
 *       habitChecks: {"date|habitId|playerId": check}, tasks, taskChecks: {"date|taskId": check} }
 */
export function buildBoards(db, today) {
  const weekStart = addDays(today, -6);
  const rows = new Map(
    db.players.map((p) => [p.id, { playerId: p.id, total: 0, week: 0, sharedDone: 0, personalDone: 0 }]),
  );
  const doneSets = new Map(); // `${habitId}|${playerId}` -> Set(dates)
  for (const c of countedChecks(db)) {
    const row = rows.get(c.playerId);
    if (!row) continue;
    const pts = c.kind === "habit" ? SHARED_POINTS : PERSONAL_POINTS;
    row.total += pts;
    if (c.date >= weekStart) row.week += pts;
    if (c.kind === "task") {
      row.personalDone++;
      continue;
    }
    row.sharedDone++;
    const k = `${c.habitId}|${c.playerId}`;
    if (!doneSets.has(k)) doneSets.set(k, new Set());
    doneSets.get(k).add(c.date);
  }

  const habitRows = new Map(); // habitId -> rows
  const perfect = [];
  for (const p of db.players) {
    const joined = p.joined || db.startDate;
    const statesByHabit = new Map();
    for (const h of db.habits) {
      const entries = db.schedules?.[p.id]?.[h.id] || [];
      const start = [h.createdDate, joined, db.startDate].sort().pop();
      const end = h.archivedDate ? addDays(h.archivedDate, -1) : today;
      const states = habitStates(doneSets.get(`${h.id}|${p.id}`) || new Set(), entries, start, end);
      statesByHabit.set(h.id, states);
      if (!habitRows.has(h.id)) habitRows.set(h.id, []);
      habitRows.get(h.id).push({
        playerId: p.id,
        target: targetOn(entries, today),
        ...streakFromStates(states, today),
      });
    }
    // A day is "perfect" when every habit was done or covered by a scheduled rest day.
    const days = new Map();
    for (let d = db.startDate; d <= today; d = addDays(d, 1)) {
      const required = db.habits.filter((h) => habitActiveOn(h, d) && statesByHabit.get(h.id).has(d));
      const open = db.habits.some((h) => habitActiveOn(h, d) && !statesByHabit.get(h.id).has(d));
      if (!required.length || open) continue; // nothing to judge yet (e.g. today still in progress)
      const st = required.map((h) => statesByHabit.get(h.id).get(d));
      days.set(d, st.includes("miss") ? "miss" : st.includes("done") ? "done" : "rest");
    }
    perfect.push({ playerId: p.id, ...streakFromStates(days, today) });
  }

  return {
    points: [...rows.values()],
    perfect,
    habits: db.habits
      .filter((h) => !h.archivedDate)
      .map((h) => ({ habitId: h.id, rows: habitRows.get(h.id) || [] })),
  };
}
