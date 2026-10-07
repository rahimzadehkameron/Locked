import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lockin-"));
process.env.LOCKIN_PASSCODE = "pw";
const { addDays, streaks } = await import("./scoring.js");
const { server } = await import("./server.js");

test("streaks: today not done yet keeps streak alive", () => {
  const set = new Set(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-10"]);
  assert.deepEqual(streaks(set, "2026-01-04"), { current: 3, best: 3, total: 4 });
  assert.equal(streaks(set, "2026-01-06").current, 0);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("api end to end", async () => {
  await new Promise((r) => server.listen(0, r));
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

  // call-outs: majority of the other players busts it (2 of 2 here); own proof can't be called
  const c = (await call("POST", "/api/login", { passcode: "pw", newName: "Cy" })).data;
  const callOut = (tok, on = true) => call("POST", "/api/call-out", { kind: "task", id: task.id, date: s.today, ownerId: a.playerId, on }, tok);
  assert.equal((await callOut(a.token)).status, 400);
  s = (await callOut(b.token)).data;
  assert.equal(s.proofs.find((x) => x.kind === "task").busted, false); // one call isn't enough
  s = (await callOut(c.token)).data;
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
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/..%2fserver.js")).status, 403);
  server.close();
});
