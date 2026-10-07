import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lockin-"));
process.env.LOCKIN_PASSCODE = "pw";
const { addDays, mondayOf, habitStates, streakFromStates, targetOn, isBusted } = await import("./scoring.js");
const { server } = await import("./server.js");

const days = (...d) => new Set(d);

test("dates", () => {
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(mondayOf("2026-10-07"), "2026-10-05"); // Wednesday
  assert.equal(mondayOf("2026-10-11"), "2026-10-05"); // Sunday
  assert.equal(mondayOf("2026-10-12"), "2026-10-12"); // Monday
});

test("streaks: every-day habit, today still open keeps streak alive", () => {
  // Mon 5th .. Wed 7th done, today = Thu 8th not yet done
  const st = habitStates(days("2026-10-05", "2026-10-06", "2026-10-07"), [], "2026-10-05", "2026-10-08");
  assert.deepEqual(streakFromStates(st, "2026-10-08"), { current: 3, best: 3, total: 3 });
  // a fully missed day breaks it (no rest days at 7/week)
  const st2 = habitStates(days("2026-10-05", "2026-10-07"), [], "2026-10-05", "2026-10-08");
  assert.equal(streakFromStates(st2, "2026-10-08").current, 1);
});

test("streaks: weekly target gives rest days that don't break the streak", () => {
  const five = [{ from: "0000-00-00", days: 5 }]; // 2 rest days a week
  assert.equal(targetOn(five, "2026-10-07"), 5);
  // Mon, Tue skipped (rests), Wed-Sun done, next Mon done
  const done = days("2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12");
  const st = habitStates(done, five, "2026-10-05", "2026-10-12");
  assert.equal(st.get("2026-10-05"), "rest");
  assert.deepEqual(streakFromStates(st, "2026-10-12"), { current: 6, best: 6, total: 6 });
  // a third miss in the same week breaks it
  const st3 = habitStates(days("2026-10-08", "2026-10-09"), five, "2026-10-05", "2026-10-10");
  assert.equal(st3.get("2026-10-07"), "miss");
  // the allowance resets on Monday
  const st4 = habitStates(days(), five, "2026-10-05", "2026-10-13");
  assert.equal(st4.get("2026-10-12"), "rest");
});

test("busting: any BS flags it, a contest needs more legit than fake votes", () => {
  assert.equal(isBusted(1), false);
  assert.equal(isBusted({ calls: {}, legit: {} }), false);
  assert.equal(isBusted({ calls: { a: {} } }), true);
  assert.equal(isBusted({ calls: { a: {} }, contest: {}, legit: { b: 1, c: 1 } }), false);
  assert.equal(isBusted({ calls: { a: {} }, contest: {}, legit: { b: 1 } }), true); // a tie stays busted
  assert.equal(isBusted({ calls: { a: {} }, contest: {}, legit: {} }), true); // owner carries the burden
});

test("api end to end", async (t) => {
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.closeAllConnections?.() ?? server.close());
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const upload = async (q, token, buf = jpeg) => {
    const res = await fetch(`${base}/api/proof?${q}`, {
      method: "POST", headers: { "Content-Type": "image/jpeg", Authorization: `Bearer ${token}` }, body: buf });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await call("POST", "/api/login", { passcode: "nope", newName: "A" })).status, 401);
  const a = (await call("POST", "/api/login", { passcode: "pw", newName: "Ann" })).data;
  const b = (await call("POST", "/api/login", { passcode: "pw", newName: "Bo" })).data;
  assert.equal((await call("POST", "/api/login", { passcode: "pw", newName: "ann" })).status, 409);
  assert.equal((await call("GET", "/api/state")).status, 401);

  let s = (await call("GET", "/api/state", null, a.token)).data;
  assert.equal(s.habits.length, 4);
  // ticking without a photo is refused
  assert.equal((await call("POST", "/api/habit-check", { habitId: s.habits[0].id, date: s.today, done: true }, a.token)).status, 400);
  assert.equal((await upload(`kind=habit&id=${s.habits[0].id}&date=${s.today}`, a.token, Buffer.from("not a jpeg"))).status, 400);
  for (const h of s.habits) {
    s = (await upload(`kind=habit&id=${h.id}&date=${s.today}`, a.token)).data;
  }
  s = (await call("POST", "/api/tasks", { text: "Laundry", daily: false }, a.token)).data;
  const task = s.tasks[s.today][0];
  s = (await upload(`kind=task&id=${task.id}&date=${s.today}`, a.token)).data;
  const ann = s.boards.points.find((r) => r.playerId === a.playerId);
  assert.equal(ann.total, 4 * 3 + 1);
  assert.equal(s.boards.perfect.find((r) => r.playerId === a.playerId).current, 1);
  assert.equal(s.boards.perfect.find((r) => r.playerId === b.playerId).current, 0);

  // proofs are visible to the crew (with auth only)
  const pr = s.proofs.find((x) => x.kind === "task");
  assert.equal((await fetch(`${base}/api/proof/${pr.proofId}`)).status, 401);
  const img = await fetch(`${base}/api/proof/${pr.proofId}`, { headers: { Authorization: `Bearer ${b.token}` } });
  assert.equal(img.headers.get("content-type"), "image/jpeg");

  // call-outs: a single BS call flags it; own proof can't be called
  const c = (await call("POST", "/api/login", { passcode: "pw", newName: "Cy" })).data;
  const callOut = (tok, on = true) => call("POST", "/api/call-out", { kind: "task", id: task.id, date: s.today, ownerId: a.playerId, on }, tok);
  assert.equal((await callOut(a.token)).status, 400);
  s = (await callOut(b.token)).data;
  assert.equal(s.proofs.find((x) => x.kind === "task").busted, true);
  assert.equal(s.boards.points.find((r) => r.playerId === a.playerId).total, 12);
  s = (await callOut(b.token, false)).data;
  assert.equal(s.boards.points.find((r) => r.playerId === a.playerId).total, 13);

  // other players can't tick my tasks; old dates rejected
  assert.equal((await call("POST", "/api/task-check", { taskId: task.id, date: s.today, done: false }, b.token)).status, 404);
  assert.equal((await upload(`kind=habit&id=${s.habits[0].id}&date=2020-01-01`, a.token)).status, 400);

  // removing a habit keeps points but drops it from the perfect-day requirement
  s = (await call("DELETE", `/api/habits/${s.habits[0].id}`, null, a.token)).data;
  assert.equal(s.habits.length, 3);
  assert.equal(s.boards.points.find((r) => r.playerId === a.playerId).total, 13);

  s = (await call("POST", "/api/messages", { text: "<b>hi</b>" }, b.token)).data;
  assert.equal(s.messages.at(-1).text, "<b>hi</b>");
  // contest + vote: the owner disputes a BS call, others vote
  const taskRef = { kind: "task", id: task.id, date: s.today, ownerId: a.playerId };
  const callAs = (tok, extra) => call("POST", "/api/call-out", { ...taskRef, ...extra }, tok);
  s = (await callAs(b.token, { on: true, reason: "screenshot" })).data;
  const view = () => s.proofs.find((x) => x.kind === "task");
  assert.equal(view().busted, true);
  assert.equal(view().calls[0].reason, "screenshot");
  assert.ok(s.messages.some((m) => m.system && m.text.includes("called BS")));
  assert.equal((await call("POST", "/api/contest", { kind: "task", id: task.id, date: s.today }, b.token)).status, 404); // only the owner can contest
  s = (await call("POST", "/api/contest", { kind: "task", id: task.id, date: s.today, note: "I did it" }, a.token)).data;
  assert.equal(view().busted, true); // owner carries the burden until votes come in
  s = (await call("POST", "/api/vote", { ...taskRef, vote: "legit" }, c.token)).data;
  assert.equal(view().busted, true); // 1 legit vs 1 fake is a tie
  s = (await call("POST", "/api/vote", { ...taskRef, vote: "legit" }, b.token)).data; // caller changes their mind
  assert.equal(view().busted, false);
  assert.equal(view().contest, null); // dispute is cleared once nobody calls BS
  assert.equal((await call("POST", "/api/vote", { ...taskRef, vote: "fake" }, a.token)).status, 400);

  // weekly schedule: first save applies now, later edits wait for Monday
  assert.equal(s.meScheduled, false);
  const hid = s.habits.map((x) => x.id);
  s = (await call("POST", "/api/schedule", { days: Object.fromEntries(hid.map((i) => [i, 5])) }, a.token)).data;
  assert.equal(s.meScheduled, true);
  assert.equal(s.schedule[hid[0]].days, 5);
  s = (await call("POST", "/api/schedule", { days: Object.fromEntries(hid.map((i) => [i, 3])) }, a.token)).data;
  assert.deepEqual([s.schedule[hid[0]].days, s.schedule[hid[0]].next], [5, 3]);
  assert.equal((await call("POST", "/api/schedule", { days: { [hid[0]]: 9 } }, a.token)).status, 400);

  // feed shows everyone's photos; export hides secrets
  const feedRes = (await call("GET", "/api/feed", null, b.token)).data;
  assert.ok(feedRes.items.length >= 4 && feedRes.items[0].proofId);
  const exp = await fetch(`${base}/api/export`, { headers: { Authorization: `Bearer ${b.token}` } });
  assert.match(exp.headers.get("content-disposition"), /attachment/);
  const exported = await exp.json();
  assert.equal(exported.sessions, undefined);
  assert.equal(exported.passcode, undefined);

  // settings: end date, passcode, removing a player
  assert.equal((await call("POST", "/api/settings", { endDate: "nope" }, a.token)).status, 400);
  assert.equal((await call("POST", "/api/passcode", { current: "wrong", next: "abcd" }, a.token)).status, 401);
  await call("POST", "/api/passcode", { current: "pw", next: "newpass" }, a.token);
  assert.equal((await call("POST", "/api/login", { passcode: "pw", playerId: a.playerId })).status, 401);
  assert.equal((await call("POST", "/api/login", { passcode: "newpass", playerId: a.playerId })).status, 200);
  assert.equal((await call("DELETE", `/api/players/${a.playerId}`, null, a.token)).status, 400);
  s = (await call("DELETE", `/api/players/${c.playerId}`, null, a.token)).data;
  assert.equal(s.players.length, 2);

  // once winter is over everything locks
  s = (await call("POST", "/api/settings", { endDate: s.startDate }, a.token)).data;
  assert.equal(s.final, null); // still the last day
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/..%2fserver.js")).status, 403);
  server.close();
});
