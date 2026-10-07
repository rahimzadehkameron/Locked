// Pure scoring helpers (no I/O) so they can be unit tested.

export const SHARED_POINTS = 3;
export const PERSONAL_POINTS = 1;

const DAY_MS = 86400000;

export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** Consecutive-day streaks for a set of YYYY-MM-DD strings. */
export function streaks(daySet, today) {
  // Current streak: today not being done yet doesn't break it.
  let cursor = daySet.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (daySet.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }
  const sorted = [...daySet].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return { current, best, total: daySet.size };
}

/**
 * A check is either 1 (legacy, no proof) or { proof, ts, calls: { playerId: ts } }.
 * It is "busted" when a majority of the *other* players called it fake.
 */
/** Majority of the other players: 1 of 1, 2 of 2, 2 of 3. */
export function bustThreshold(playerCount) {
  return Math.floor(Math.max(1, playerCount - 1) / 2) + 1;
}

export function isBusted(check, playerCount) {
  const calls = check && typeof check === "object" ? Object.keys(check.calls || {}).length : 0;
  const needed = bustThreshold(playerCount);
  return calls >= needed;
}

export function habitActiveOn(h, date) {
  return h.createdDate <= date && (!h.archivedDate || date < h.archivedDate);
}

export function taskActiveOn(t, date) {
  if (!t.daily && t.createdDate !== date) return false;
  return t.createdDate <= date && (!t.archivedDate || date < t.archivedDate);
}

/**
 * Build leaderboard data.
 * db: { players, habits, habitChecks: {"date|habitId|playerId":1}, tasks, taskChecks: {"date|taskId":1} }
 */
export function buildBoards(db, today) {
  const weekStart = addDays(today, -6);
  const rows = new Map(
    db.players.map((p) => [
      p.id,
      { playerId: p.id, total: 0, week: 0, sharedDone: 0, personalDone: 0 },
    ]),
  );
  const perHabitDays = new Map(); // habitId -> playerId -> Set(dates)
  const playerDays = new Map(); // playerId -> date -> Set(habitIds)
  const n = db.players.length;
  for (const [key, check] of Object.entries(db.habitChecks)) {
    if (isBusted(check, n)) continue;
    const [date, habitId, playerId] = key.split("|");
    const row = rows.get(playerId);
    if (!row) continue;
    row.total += SHARED_POINTS;
    row.sharedDone++;
    if (date >= weekStart) row.week += SHARED_POINTS;
    if (!perHabitDays.has(habitId)) perHabitDays.set(habitId, new Map());
    const byPlayer = perHabitDays.get(habitId);
    if (!byPlayer.has(playerId)) byPlayer.set(playerId, new Set());
    byPlayer.get(playerId).add(date);
    if (!playerDays.has(playerId)) playerDays.set(playerId, new Map());
    const byDate = playerDays.get(playerId);
    if (!byDate.has(date)) byDate.set(date, new Set());
    byDate.get(date).add(habitId);
  }
  const taskOwner = new Map(db.tasks.map((t) => [t.id, t.playerId]));
  for (const [key, check] of Object.entries(db.taskChecks)) {
    if (isBusted(check, n)) continue;
    const [date, taskId] = key.split("|");
    const row = rows.get(taskOwner.get(taskId));
    if (!row) continue;
    row.total += PERSONAL_POINTS;
    row.personalDone++;
    if (date >= weekStart) row.week += PERSONAL_POINTS;
  }

  // Perfect days: every shared habit active that day was done.
  const perfect = [];
  for (const p of db.players) {
    const days = new Set();
    const byDate = playerDays.get(p.id) || new Map();
    for (const [date, done] of byDate) {
      const required = db.habits.filter((h) => habitActiveOn(h, date));
      if (required.length && required.every((h) => done.has(h.id))) days.add(date);
    }
    perfect.push({ playerId: p.id, ...streaks(days, today) });
  }

  const habits = db.habits
    .filter((h) => !h.archivedDate)
    .map((h) => ({
      habitId: h.id,
      rows: db.players.map((p) => ({
        playerId: p.id,
        ...streaks(perHabitDays.get(h.id)?.get(p.id) || new Set(), today),
      })),
    }));

  return { points: [...rows.values()], perfect, habits };
}
