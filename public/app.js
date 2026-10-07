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
let feed = null; // photo feed items (loaded when the Feed tab is open)
let feedLimit = 24;
let feedMore = false;
let schedDraft = null; // weekly-schedule editor state: habitId -> days

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
  if (tab === "feed") await loadFeed(false);
  if (render) renderMain();
}
async function loadFeed(render = true) {
  const r = await api("GET", `/api/feed?limit=${feedLimit}`);
  feed = r.items; feedMore = r.more;
  if (render && tab === "feed") renderMain();
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
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
function dayLabel() {
  if (S.today > S.endDate) return "Winter's over ❄️";
  return `Day ${daysBetween(S.startDate, S.today) + 1} of ${daysBetween(S.startDate, S.endDate) + 1}`;
}
const editable = (date) => S.today <= S.endDate && (date === S.today || date === S.yesterday);

function renderMain() {
  if (!S) return;
  if (!S.meScheduled) { renderOnboarding(); return; }
  const me = player(S.me);
  if (tab === "feed" && feed === null) loadFeed();
  const view = { today: viewToday, board: viewBoard, chat: viewChat, crew: viewCrew, feed: viewFeed, settings: viewSettings }[tab]();
  const tabs = [["today", "✅", "Today"], ["board", "🏆", "Board"], ["feed", "📸", "Feed"], ["crew", "👥", "Crew"], ["chat", "💬", "Chat"]];
  $app.replaceChildren(
    h("header", { class: "top" },
      h("div", {}, h("h1", {}, "❄️ Winter Lock-In"), h("small", {}, `${dayLabel()} · ${fmtDay(S.today)}`)),
      h("button", { class: "x", title: "Settings", onclick: () => { schedDraft = null; tab = tab === "settings" ? "today" : "settings"; renderMain(); } }, avatar(me, 34))),
    h("main", {}, view),
    h("nav", { class: "tabs" }, tabs.map(([id, icon, label]) =>
      h("button", { class: tab === id ? "on" : "", onclick: () => { tab = id; store.set("lockin-tab", id); renderMain(); } },
        h("b", {}, icon), label))));
  if (tab === "chat") scrollChat();
  renderModal();
}

function toast(text, label, onAction) {
  document.getElementById("toast")?.remove();
  const t = h("div", { id: "toast", class: "toast" }, text,
    label && h("button", { onclick: () => { t.remove(); onAction(); } }, label));
  document.body.append(t);
  setTimeout(() => t.remove(), 7000);
}

// ---------- Weekly schedule (onboarding + settings) ----------
function scheduleEditor() {
  schedDraft ||= Object.fromEntries(S.habits.map((x) => [x.id, S.schedule[x.id]?.next ?? S.schedule[x.id]?.days ?? 7]));
  const setAll = (n) => { for (const x of S.habits) schedDraft[x.id] = n; renderMain(); };
  return h("div", {},
    h("div", { class: "chips" }, [7, 6, 5, 4, 3].map((n) =>
      h("button", { class: "chip", onclick: () => setAll(n) }, n === 7 ? "Every day" : `${n}×/week`))),
    S.habits.map((x) => h("div", { class: "row" },
      h("span", { class: "label" }, `${x.emoji} ${x.name}`),
      h("div", { class: "stepper" },
        h("button", { onclick: () => { schedDraft[x.id] = Math.max(1, (schedDraft[x.id] ?? 7) - 1); renderMain(); } }, "−"),
        h("b", {}, `${schedDraft[x.id] ?? 7}×`),
        h("button", { onclick: () => { schedDraft[x.id] = Math.min(7, (schedDraft[x.id] ?? 7) + 1); renderMain(); } }, "+")))),
    h("div", { class: "muted", style: "margin-top:6px" },
      "Days per week you commit to. The days you don't need are rest days: skipping them won't break your streak."));
}
async function saveSchedule() {
  await act("POST", "/api/schedule", { days: schedDraft });
  schedDraft = null;
  if (tab === "settings") toast("Saved. Changes start next Monday.");
}
function renderOnboarding() {
  $app.replaceChildren(h("div", { class: "login" },
    h("h1", {}, `Hey ${player(S.me).name} 👋`),
    h("p", { class: "muted" }, "Set your baseline. How many days a week are you locking in on each habit?"),
    h("section", { class: "card" }, scheduleEditor()),
    h("button", { class: "btn", style: "width:100%", onclick: saveSchedule }, "Start locking in")));
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
        const ref = { date, kind: "habit", refId: x.id, playerId: S.me };
        return h("div", { class: "row" },
          checkButton(ref, myDone.has(x.id), x.name),
          h("span", { class: "label" }, `${x.emoji} ${x.name}`,
            isToday && S.weekProgress[x.id]?.target < 7 &&
              h("span", { class: "pill", style: "margin-left:8px", title: "This week vs your weekly goal" },
                `${S.weekProgress[x.id].done}/${S.weekProgress[x.id].target} wk`)),
          isToday && h("span", { class: "dots" }, dones.map((id) =>
            h("button", { class: "dotbtn", title: `See ${player(id).name}'s proof`,
              onclick: () => openProof({ date, kind: "habit", refId: x.id, playerId: id }) }, avatar(player(id), 20)))),
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
        checkButton({ date, kind: "task", refId: t.id, playerId: S.me }, t.done, t.text),
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
  if (S.final) parts.push(finalCard());
  else if (S.lastWeek) parts.push(lastWeekCard());
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
    h("div", { class: "muted" }, "Every shared habit done, day after day. Scheduled rest days don't break it."),
    rankRows([...S.boards.perfect].sort((a, b) => b.current - a.current || b.best - a.best || b.total - a.total),
      (r) => [`${r.current}d`, `best ${r.best}d · ${r.total} days total`])));

  for (const hb of S.boards.habits) {
    const habit = S.habits.find((x) => x.id === hb.habitId);
    if (!habit) continue;
    parts.push(h("section", { class: "card" },
      h("h2", {}, `${habit.emoji} ${habit.name}`),
      rankRows([...hb.rows].sort((a, b) => b.current - a.current || b.total - a.total || b.best - a.best),
        (r) => [`${r.current}d`, `best ${r.best}d · ${r.total} days${r.target < 7 ? ` · ${r.target}×/wk` : ""}`])));
  }
  return parts;
}
function lastWeekCard() {
  const { rows, start, end } = S.lastWeek;
  const top = rows[0], last = rows[rows.length - 1];
  return h("section", { class: "card banner" },
    h("h2", {}, `🏅 Last week · ${fmtDay(start)} – ${fmtDay(end)}`),
    h("div", {}, h("b", {}, player(top.playerId).name), ` won with ${top.points} pts.`),
    rows.length > 1 && last.playerId !== top.playerId &&
      h("div", { class: "muted", style: "margin-top:4px" },
        `☕ ${player(last.playerId).name} finished last (${last.points}), so they pick this week's challenge or buy coffee.`));
}
function finalCard() {
  const f = S.final;
  const champ = f.points[0];
  const best = f.bestStreak && f.bestStreak.best > 0 ? f.bestStreak : null;
  const mostPhotos = [...f.photos].sort((a, b) => b.count - a.count)[0];
  return h("section", { class: "card banner" },
    h("h2", {}, "🏆 Final standings"),
    h("div", { style: "font-size:20px" }, "👑 ", h("b", {}, player(champ.playerId).name), ` wins with ${champ.total} pts!`),
    best && h("div", { class: "muted", style: "margin-top:6px" }, `🔥 Longest perfect streak: ${player(best.playerId).name} (${best.best} days)`),
    mostPhotos?.count > 0 && h("div", { class: "muted" }, `📸 Most proof photos: ${player(mostPhotos.playerId).name} (${mostPhotos.count})`),
    h("div", { class: "muted", style: "margin-top:6px" }, "Everything is locked now. Great winter, crew."));
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
        h("span", { class: "label" }, `${x.emoji} ${x.name}`),
        crewMark({ date: S.today, kind: "habit", refId: x.id, playerId: p.id }, done.includes(x)))),
      tasks.length > 0 && h("div", { class: "muted", style: "margin-top:8px" }, "Personal list"),
      tasks.map((t) => h("div", { class: "row" }, h("span", { class: "label" }, t.text),
        crewMark({ date: S.today, kind: "task", refId: t.id, playerId: p.id }, t.done))));
  });
}

// ---------- Chat ----------
function chatMessages() {
  let last = null;
  return S.messages.map((m) => {
    if (m.system) { last = null; return h("div", { class: "sysmsg" }, m.text); }
    const mine = m.playerId === S.me;
    const p = player(m.playerId);
    const showName = !mine && last !== m.playerId;
    last = m.playerId;
    const time = new Date(m.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return h("div", { class: `msg ${mine ? "me" : ""}`, title: time }, showName && h("span", { class: "who" }, p ? p.name : "Former member"), m.text);
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

// ---------- photo proof ----------
const sameRef = (r) => (x) => x.date === r.date && x.kind === r.kind && x.refId === r.refId && x.playerId === r.playerId;
const proofOf = (r) => S.proofs.find(sameRef(r)) || feed?.find(sameRef(r));
const refQuery = (r) => `kind=${r.kind}&id=${r.refId}&date=${r.date}`;

// Unticked -> take/pick a photo (that's what ticks it). Ticked -> look at the proof.
function checkButton(ref, done, label) {
  const pr = proofOf(ref);
  const state = pr?.busted ? "bust" : done ? "on" : "off";
  return h("button", { class: `check ${state}`, "aria-label": `${label}: ${state === "off" ? "add photo proof" : "view proof"}`,
    onclick: () => (state === "off" ? pickPhoto(ref) : openProof(ref)) }, state === "bust" ? "🚨" : null);
}
function crewMark(ref, done) {
  const pr = proofOf(ref);
  if (pr?.busted) return h("button", { class: "x", onclick: () => openProof(ref) }, "🚨");
  if (!done) return h("span", {}, "⬜");
  return h("button", { class: "x", title: "View proof", onclick: () => openProof(ref) }, pr ? "📷" : "✅");
}

async function toJpeg(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't read that photo"))), "image/jpeg", 0.72));
}

function pickPhoto(ref) {
  const input = h("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none" });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    const busy = h("div", { class: "overlay" }, h("div", { class: "sheet" }, "Uploading proof…"));
    document.body.append(busy);
    try {
      const blob = await toJpeg(file);
      const res = await fetch(`/api/proof?${refQuery(ref)}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg" }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");
      S = data; closeModal(); renderMain();
      toast("Checked off ✓", "Undo", () => act("POST", ref.kind === "habit" ? "/api/habit-check" : "/api/task-check",
        { habitId: ref.refId, taskId: ref.refId, date: ref.date, done: false }));
    } catch (e) { alert(e.message); }
    busy.remove();
  });
  document.body.append(input);
  input.click();
}

const photoUrls = new Map(); // proofId -> Promise<objectURL> (images need the auth header, so fetch as blob)
function photoUrl(proofId) {
  if (!photoUrls.has(proofId)) {
    photoUrls.set(proofId, fetch(`/api/proof/${proofId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => { if (!r.ok) throw new Error(); return r.blob(); }).then((b) => URL.createObjectURL(b)));
  }
  return photoUrls.get(proofId);
}

let modalRef = null;
function closeModal() { modalRef = null; document.getElementById("modal")?.remove(); }
function openProof(ref) { modalRef = ref; renderModal(); }
function itemName(ref) {
  const pr = proofOf(ref);
  if (pr?.label) return pr.label;
  if (ref.kind === "habit") { const x = S.habits.find((y) => y.id === ref.refId); return x ? `${x.emoji} ${x.name}` : "habit"; }
  for (const d of Object.values(S.tasks)) { const t = d.find((y) => y.id === ref.refId); if (t) return t.text; }
  return "task";
}
function renderModal() {
  document.getElementById("modal")?.remove();
  if (!modalRef || !S) return;
  const ref = modalRef, pr = proofOf(ref), owner = player(ref.playerId), mine = ref.playerId === S.me;
  if (!owner || (!pr && !mine)) { closeModal(); return; }
  const canEdit = editable(ref.date);
  const calls = pr ? pr.calls : [];
  const iCalled = calls.some((c) => c.id === S.me);
  const iVotedLegit = !!pr?.legit.includes(S.me);
  const img = h("img", { class: "proofimg", alt: "proof" });
  if (pr) photoUrl(pr.proofId).then((u) => (img.src = u)).catch(() => img.replaceWith(h("div", { class: "muted" }, "Photo expired (old photos are cleaned up)")));
  const uncheckBody = { habitId: ref.refId, taskId: ref.refId, date: ref.date, done: false };
  const remove = () => act("POST", ref.kind === "habit" ? "/api/habit-check" : "/api/task-check", uncheckBody).then(closeModal);
  const target = { kind: ref.kind, id: ref.refId, date: ref.date, ownerId: ref.playerId };
  const callBS = () => {
    const reason = prompt(`Why is this BS? (optional, ${owner.name} will see it)`);
    if (reason !== null) act("POST", "/api/call-out", { ...target, on: true, reason });
  };
  const contest = () => {
    const note = prompt("Say why it's legit (optional). The others will vote.");
    if (note !== null) act("POST", "/api/contest", { kind: ref.kind, id: ref.refId, date: ref.date, note });
  };
  const vote = (v) => act("POST", "/api/vote", { ...target, vote: v });
  const myVote = iVotedLegit ? "legit" : iCalled ? "fake" : null;

  let actions = null;
  if (canEdit && pr) {
    if (mine) {
      actions = h("div", {},
        pr.busted && !pr.contest && h("button", { class: "btn", style: "width:100%;margin-bottom:8px", onclick: contest }, "⚖️ Contest it. It's legit"),
        h("div", { class: "add" },
          h("button", { class: "btn ghost", onclick: () => { closeModal(); pickPhoto(ref); } }, "Replace photo"),
          h("button", { class: "btn ghost", onclick: remove }, "Uncheck")));
    } else if (pr.contest) {
      actions = h("div", {},
        h("div", { class: "muted", style: "margin-bottom:6px" }, "Cast your vote:"),
        h("div", { class: "add", style: "margin-top:0" },
          h("button", { class: myVote === "legit" ? "btn" : "btn ghost", onclick: () => vote("legit") }, "✅ Legit"),
          h("button", { class: myVote === "fake" ? "btn danger" : "btn ghost", onclick: () => vote("fake") }, "🚨 Fake")));
    } else {
      actions = h("button", { class: iCalled ? "btn ghost" : "btn danger", style: "width:100%",
        onclick: iCalled ? () => act("POST", "/api/call-out", { ...target, on: false }) : callBS },
        iCalled ? "Take my BS call back" : calls.length ? "🚨 I agree, it's BS" : "🚨 Call BS");
    }
  }

  const modal = h("div", { class: "overlay", id: "modal", onclick: (e) => e.target.classList.contains("overlay") && closeModal() },
    h("div", { class: "sheet" },
      h("div", { class: "row", style: "border:0;padding-top:0" }, avatar(owner), h("div", { class: "label" },
        h("b", {}, mine ? "You" : owner.name), ` · ${itemName(ref)}`,
        h("div", { class: "muted" }, pr ? new Date(pr.ts).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "")),
        h("button", { class: "x", onclick: closeModal }, "✕")),
      pr ? img : h("div", { class: "muted" }, "Checked off before photo proof existed."),
      pr?.busted && h("div", { class: "busted" }, "🚨 BS! This is flagged as fake, so it doesn't count."),
      calls.map((c) => h("div", { class: "muted", style: "margin-top:6px" },
        `🚨 ${player(c.id)?.name ?? "Someone"} called BS${c.reason ? `: “${c.reason}”` : ""}`)),
      pr?.contest && h("div", { class: "muted", style: "margin-top:6px" },
        `⚖️ Contested${pr.contest.note ? `: “${pr.contest.note}”` : ""} · ${pr.legit.length} legit vs ${calls.length} fake. It clears if legit gets more votes.`),
      pr && !calls.length && h("div", { class: "muted", style: "margin:8px 0" }, "Looks legit? If not, one BS call flags it."),
      h("div", { style: "margin-top:10px" }, actions)));
  document.body.append(modal);
}

// ---------- Feed ----------
function viewFeed() {
  if (feed === null) return h("div", { class: "muted", style: "padding:16px" }, "Loading…");
  if (!feed.length) return h("section", { class: "card" }, h("div", { class: "muted" }, "No proof photos yet. Be the first. 📸"));
  return [
    h("div", { class: "feed" }, feed.map((it) => {
      const p = player(it.playerId);
      const img = h("img", { alt: "", loading: "lazy" });
      photoUrl(it.proofId).then((u) => (img.src = u)).catch(() => {});
      return h("button", { class: `tile ${it.busted ? "bust" : ""}`, onclick: () => openProof(it) },
        img,
        it.busted && h("span", { class: "badge" }, "🚨 BS"),
        h("span", { class: "cap" }, `${p ? p.name : "?"} · ${it.label}`,
          h("small", {}, new Date(it.ts).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }))));
    })),
    feedMore && h("button", { class: "btn ghost", style: "width:100%;margin-top:12px", onclick: () => { feedLimit += 24; loadFeed(); } }, "Load more"),
  ];
}

// ---------- Settings ----------
function viewSettings() {
  const curPass = h("input", { class: "field", type: "password", placeholder: "Current passcode", autocomplete: "off" });
  const newPass = h("input", { class: "field", type: "password", placeholder: "New passcode (4+ characters)", autocomplete: "new-password" });
  const end = h("input", { class: "field", type: "date", value: S.endDate });
  const download = async () => {
    try {
      const res = await fetch("/api/export", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Couldn't download the backup");
      const url = URL.createObjectURL(await res.blob());
      const a = h("a", { href: url, download: `lockin-backup-${S.today}.json` });
      document.body.append(a); a.click(); a.remove();
    } catch (e) { alert(e.message); }
  };
  return [
    h("section", { class: "card" }, h("h2", {}, "My weekly schedule"), scheduleEditor(),
      h("button", { class: "btn", style: "width:100%;margin-top:10px", onclick: saveSchedule }, "Save schedule"),
      h("div", { class: "muted", style: "margin-top:6px" }, "Edits apply from next Monday so nobody can dodge a streak mid-week.")),
    h("section", { class: "card" }, h("h2", {}, "Winter ends"),
      h("div", { class: "add", style: "margin-top:0" }, end,
        h("button", { class: "btn ghost", onclick: () => act("POST", "/api/settings", { endDate: end.value }) }, "Save"))),
    h("section", { class: "card" }, h("h2", {}, "Crew passcode"), curPass, h("div", { style: "height:8px" }), newPass,
      h("button", { class: "btn ghost", style: "width:100%;margin-top:10px", onclick: async () => {
        try { S = await api("POST", "/api/passcode", { current: curPass.value, next: newPass.value }); toast("Passcode changed"); renderMain(); }
        catch (e) { alert(e.message); }
      } }, "Change passcode")),
    h("section", { class: "card" }, h("h2", {}, "Crew"),
      S.players.map((p) => h("div", { class: "row" }, avatar(p), h("span", { class: "label" }, p.name, p.id === S.me && h("span", { class: "muted" }, " (you)")),
        p.id !== S.me && h("button", { class: "x", title: `Remove ${p.name}`, onclick: () => {
          if (confirm(`Remove ${p.name} and delete all their check-ins and photos? This can't be undone.`)) act("DELETE", `/api/players/${p.id}`);
        } }, "Remove")))),
    h("section", { class: "card" }, h("h2", {}, "Backup"),
      h("div", { class: "muted", style: "margin-bottom:8px" }, "Scores, lists and chat as a file. (Photos stay on the server.) The server also keeps a daily copy."),
      h("button", { class: "btn ghost", style: "width:100%", onclick: download }, "Download backup")),
    h("button", { class: "btn ghost", style: "width:100%", onclick: logout }, "Switch user / log out"),
  ];
}

// ---------- boot ----------
if (token) start(); else renderLogin();
