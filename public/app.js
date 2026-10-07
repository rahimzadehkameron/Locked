const $app = document.getElementById("app");
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let token = store.get("lockin-token");
let S = null; // latest state
let tab = store.get("lockin-tab") || "today";
let boardMode = "week";
let chatDraft = "";
let pollTimer = null;

// ---------- tiny DOM helper (text is always set via textContent, never innerHTML) ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function logout() {
  token = null; S = null; store.del("lockin-token"); clearInterval(pollTimer);
  renderLogin();
}

const player = (id) => S.players.find((p) => p.id === id);
const initial = (p) => (p ? p.name[0].toUpperCase() : "?");
const avatar = (p, size) =>
  h("span", { class: "avatar", style: `background:${p.color}${size ? `;width:${size}px;height:${size}px;font-size:${size / 2}px` : ""}`, title: p.name }, initial(p));

// ---------- login ----------
async function renderLogin() {
  let info = { players: [], maxPlayers: 4 };
  try { info = await api("GET", "/api/players"); } catch { /* offline */ }
  let picked = null;
  const err = h("div", { class: "err" });
  const pass = h("input", { class: "field", type: "password", placeholder: "Crew passcode", autocomplete: "current-password" });
  const nameIn = h("input", { class: "field", type: "text", placeholder: "Your name", maxlength: "20" });
  const names = h("div", { class: "names" });
  const draw = () => {
    names.replaceChildren(
      ...info.players.map((p) =>
        h("button", { class: picked === p.id ? "on" : "", onclick: () => { picked = p.id; draw(); } }, p.name)),
      info.players.length < info.maxPlayers &&
        h("button", { class: picked === "new" ? "on" : "", onclick: () => { picked = "new"; draw(); } }, "＋ I'm new"),
    );
    nameIn.style.display = picked === "new" ? "" : "none";
  };
  draw();
  const go = async () => {
    err.textContent = "";
    if (!picked) { err.textContent = "Pick who you are"; return; }
    try {
      const body = { passcode: pass.value, ...(picked === "new" ? { newName: nameIn.value } : { playerId: picked }) };
      const r = await api("POST", "/api/login", body);
      token = r.token; store.set("lockin-token", token);
      start();
    } catch (e) { err.textContent = e.message; }
  };
  $app.replaceChildren(h("div", { class: "login" },
    h("h1", {}, "❄️ Winter Lock-In"),
    h("p", { class: "muted" }, "Who's locking in?"),
    names, nameIn, h("div", { style: "height:8px" }), pass, err,
    h("button", { class: "btn", style: "width:100%", onclick: go }, "Let's go")));
}

// ---------- main ----------
async function refresh(render = true) {
  S = await api("GET", "/api/state");
  if (render) renderMain();
}
function start() {
  refresh().catch(() => {});
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // Don't repaint while someone is typing.
    if (document.activeElement?.tagName === "INPUT") {
      refresh(false).then(() => { if (tab === "chat") updateChatOnly(); }).catch(() => {});
    } else refresh().catch(() => {});
  }, 5000);
}
async function act(method, url, body) {
  try { S = await api(method, url, body); renderMain(); } catch (e) { alert(e.message); }
}

function fmtDay(d) { return new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
function dayNumber() { return Math.floor((new Date(S.today) - new Date(S.startDate)) / 86400000) + 1; }

function renderMain() {
  if (!S) return;
  const me = player(S.me);
  const view = { today: viewToday, board: viewBoard, chat: viewChat, crew: viewCrew }[tab]();
  const tabs = [["today", "✅", "Today"], ["board", "🏆", "Board"], ["crew", "👥", "Crew"], ["chat", "💬", "Chat"]];
  $app.replaceChildren(
    h("header", { class: "top" },
      h("div", {}, h("h1", {}, "❄️ Winter Lock-In"), h("small", {}, `Day ${dayNumber()} · ${fmtDay(S.today)}`)),
      h("button", { class: "x", title: "Switch user", onclick: logout }, avatar(me, 34))),
    h("main", {}, view),
    h("nav", { class: "tabs" }, tabs.map(([id, icon, label]) =>
      h("button", { class: tab === id ? "on" : "", onclick: () => { tab = id; store.set("lockin-tab", id); renderMain(); } },
        h("b", {}, icon), label))));
  if (tab === "chat") scrollChat();
}

// ---------- Today ----------
function viewToday() {
  const dates = [S.today, S.yesterday];
  const parts = [];
  parts.push(weekCard());
  for (const date of dates) {
    const isToday = date === S.today;
    const myDone = new Set(S.myChecks[date] || []);
    const habitsFor = S.habits.filter((x) => S.habitsActive[date]?.includes(x.id));
    const tasks = (S.tasks[date] || []).filter((t) => t.playerId === S.me);
    if (!isToday && habitsFor.every((x) => myDone.has(x.id)) && tasks.every((t) => t.done)) continue;
    parts.push(h("section", { class: "card" },
      h("h2", {}, isToday ? "Shared habits · 3 pts each" : "Catch up on yesterday",
        h("span", { class: "pill" }, `${habitsFor.filter((x) => myDone.has(x.id)).length}/${habitsFor.length}`)),
      habitsFor.map((x) => {
        const dones = isToday ? S.sharedToday[x.id] || [] : [];
        return h("div", { class: "row" },
          h("button", { class: `check ${myDone.has(x.id) ? "on" : ""}`, "aria-label": `Toggle ${x.name}`,
            onclick: () => act("POST", "/api/habit-check", { habitId: x.id, date, done: !myDone.has(x.id) }) }),
          h("span", { class: "label" }, `${x.emoji} ${x.name}`),
          isToday && h("span", { class: "dots" }, dones.map((id) => avatar(player(id), 20))),
          isToday && h("button", { class: "x", title: "Remove habit for everyone", onclick: () => {
            if (confirm(`Remove "${x.name}" for the whole crew? Past points are kept.`)) act("DELETE", `/api/habits/${x.id}`);
          } }, "×"));
      }),
      isToday && addHabitForm()));
    parts.push(h("section", { class: "card" },
      h("h2", {}, isToday ? "My list · 1 pt each" : "My list (yesterday)",
        h("span", { class: "pill" }, `${tasks.filter((t) => t.done).length}/${tasks.length}`)),
      tasks.length === 0 && h("div", { class: "muted" }, "Nothing here yet."),
      tasks.map((t) => h("div", { class: "row" },
        h("button", { class: `check ${t.done ? "on" : ""}`, onclick: () => act("POST", "/api/task-check", { taskId: t.id, date, done: !t.done }) }),
        h("span", { class: "label" }, t.text, t.daily && h("span", { class: "pill", style: "margin-left:8px" }, "daily")),
        isToday && h("button", { class: "x", onclick: () => act("DELETE", `/api/tasks/${t.id}`) }, "×"))),
      isToday && addTaskForm()));
  }
  return parts;
}

function weekCard() {
  return h("section", { class: "card" }, h("h2", {}, "My week"),
    h("div", { class: "week" }, S.weekDays.map((d) => {
      const req = S.habitsActive[d] || [];
      const done = (S.myChecks[d] || []).filter((id) => req.includes(id)).length;
      const cls = req.length && done === req.length ? "full" : done ? "part" : "";
      return h("div", {}, new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "narrow" }), h("i", { class: cls }));
    })));
}

function addHabitForm() {
  const emoji = h("input", { type: "text", class: "field", style: "flex:0 0 56px;text-align:center", placeholder: "⭐", maxlength: "4" });
  const name = h("input", { type: "text", placeholder: "New shared habit…", maxlength: "30" });
  const submit = (e) => { e.preventDefault(); if (name.value.trim()) act("POST", "/api/habits", { name: name.value, emoji: emoji.value }); };
  return h("form", { class: "add", onsubmit: submit }, emoji, name, h("button", { class: "btn ghost" }, "Add"));
}
function addTaskForm() {
  const text = h("input", { type: "text", placeholder: "Add to my list…", maxlength: "80" });
  const daily = h("input", { type: "checkbox", id: "daily" });
  const submit = (e) => { e.preventDefault(); if (text.value.trim()) act("POST", "/api/tasks", { text: text.value, daily: daily.checked }); };
  return h("form", { onsubmit: submit },
    h("div", { class: "add" }, text, h("button", { class: "btn ghost" }, "Add")),
    h("label", { class: "muted", style: "display:block;margin-top:6px" }, daily, " Repeat every day"));
}

// ---------- Board ----------
function viewBoard() {
  const parts = [];
  const key = boardMode === "week" ? "week" : "total";
  parts.push(h("section", { class: "card" },
    h("h2", {}, "Points"),
    h("div", { class: "seg" },
      [["week", "Last 7 days"], ["all", "All time"]].map(([m, label]) =>
        h("button", { class: boardMode === m ? "on" : "", onclick: () => { boardMode = m; renderMain(); } }, label))),
    rankRows([...S.boards.points].sort((a, b) => b[key] - a[key] || b.total - a.total),
      (r) => [String(r[key]), `${r.sharedDone} shared · ${r.personalDone} personal`]),
    h("div", { class: "muted", style: "margin-top:6px" }, "Shared habits = 3 pts, personal tasks = 1 pt.")));

  parts.push(h("section", { class: "card" },
    h("h2", {}, "🔥 Perfect-day streak"),
    h("div", { class: "muted" }, "Every shared habit done, day after day."),
    rankRows([...S.boards.perfect].sort((a, b) => b.current - a.current || b.best - a.best || b.total - a.total),
      (r) => [`${r.current}d`, `best ${r.best}d · ${r.total} days total`])));

  for (const hb of S.boards.habits) {
    const habit = S.habits.find((x) => x.id === hb.habitId);
    if (!habit) continue;
    parts.push(h("section", { class: "card" },
      h("h2", {}, `${habit.emoji} ${habit.name}`),
      rankRows([...hb.rows].sort((a, b) => b.current - a.current || b.total - a.total || b.best - a.best),
        (r) => [`${r.current}d`, `best ${r.best}d · ${r.total} days`])));
  }
  return parts;
}
function rankRows(rows, fmt) {
  return rows.map((r, i) => {
    const p = player(r.playerId);
    const [big, small] = fmt(r);
    return h("div", { class: "row" },
      h("span", { class: `rank ${i === 0 ? "r1" : ""}` }, i === 0 ? "👑" : String(i + 1)),
      avatar(p), h("span", { class: "label" }, p.name, r.playerId === S.me && h("span", { class: "muted" }, " (you)")),
      h("span", { class: "score" }, big, h("small", {}, small)));
  });
}

// ---------- Crew (everyone's day) ----------
function viewCrew() {
  return S.players.map((p) => {
    const done = S.habits.filter((x) => (S.sharedToday[x.id] || []).includes(p.id));
    const tasks = (S.tasks[S.today] || []).filter((t) => t.playerId === p.id);
    return h("section", { class: "card" },
      h("h2", {}, h("span", { style: "display:flex;align-items:center;gap:8px" }, avatar(p), p.name),
        h("span", { class: "pill" }, `${done.length}/${S.habits.length} shared`)),
      S.habits.map((x) => h("div", { class: "row" },
        h("span", { class: "label" }, `${x.emoji} ${x.name}`), h("span", {}, done.includes(x) ? "✅" : "⬜"))),
      tasks.length > 0 && h("div", { class: "muted", style: "margin-top:8px" }, "Personal list"),
      tasks.map((t) => h("div", { class: "row" }, h("span", { class: "label" }, t.text), h("span", {}, t.done ? "✅" : "⬜"))));
  });
}

// ---------- Chat ----------
function chatMessages() {
  let last = null;
  return S.messages.map((m) => {
    const mine = m.playerId === S.me;
    const p = player(m.playerId);
    const showName = !mine && last !== m.playerId;
    last = m.playerId;
    const time = new Date(m.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return h("div", { class: `msg ${mine ? "me" : ""}`, title: time }, showName && h("span", { class: "who" }, p ? p.name : "?"), m.text);
  });
}
function scrollChat() { const c = document.getElementById("chat"); if (c) c.scrollTop = c.scrollHeight; }
function updateChatOnly() {
  const c = document.getElementById("chat");
  if (!c) return;
  const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
  c.replaceChildren(...chatMessages());
  if (atBottom) scrollChat();
}
function viewChat() {
  const input = h("input", { type: "text", placeholder: "Message the crew…", maxlength: "500", value: chatDraft,
    oninput: (e) => { chatDraft = e.target.value; } });
  const submit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    chatDraft = "";
    await act("POST", "/api/messages", { text });
    document.querySelector(".add input")?.focus();
  };
  return h("section", { class: "card" },
    h("div", { class: "chat", id: "chat" }, S.messages.length ? chatMessages() : h("div", { class: "muted" }, "No messages yet. Talk some trash. ❄️")),
    h("form", { class: "add", onsubmit: submit }, input, h("button", { class: "btn" }, "Send")));
}

// ---------- boot ----------
if (token) start(); else renderLogin();
