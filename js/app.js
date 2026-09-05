import { LEAGUE_PASSCODE, VERSION } from "./config.js";
import * as api from "./api.js";

const $ = s => document.querySelector(s);
const state = {
  view: "schedule", week: null, calendar: [], games: [],
  player: JSON.parse(localStorage.getItem("player") || "null"),
  league: JSON.parse(localStorage.getItem("league") || "null"),
  players: [], picks: [],           // picks: this league's picks this season
  weekGames: new Map(),             // week -> games (for standings)
  showFinished: false,              // My picks: finished games are tucked away by default
  showJoin: false,                  // signed-in user asked to join/start another league
};

// ---------- boot ----------

(async function boot() {
  $("#tz").textContent = `v${VERSION} · ` + Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, " ");
  bindNav();
  try {
    state.calendar = await api.fetchCalendar();
  } catch {
    state.calendar = Array.from({ length: 15 }, (_, i) => ({ value: i + 1, label: `Week ${i + 1}` }));
  }
  const now = Date.now();
  const cur = state.calendar.find(c => c.end && now >= c.start && now <= c.end)
           || state.calendar.find(c => c.end && now < c.end) || state.calendar[0];
  state.week = cur.value;
  buildWeekStrip();
  if (api.isConfigured()) {
    // Phones that joined before leagues existed have a player but no league saved.
    if (state.player && !state.league) {
      try {
        const lg = await api.getPlayerLeague(state.player.id);
        if (lg) { state.league = lg; localStorage.setItem("league", JSON.stringify(lg)); }
        else { localStorage.removeItem("player"); state.player = null; } // player row is gone
      } catch (e) { showLeagueError(e); } // network blip: stay signed in, retry next open
    }
    if (state.league) await loadLeague().catch(showLeagueError);
  }
  await loadWeek(state.week);
})();

function bindNav() {
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  $("#signout").onclick = () => {
    localStorage.removeItem("player"); localStorage.removeItem("league");
    state.player = null; state.league = null; state.players = []; state.picks = [];
    state.showJoin = false;
    render();
  };
  $("#share").onclick = () => {
    $("#modaltitle").textContent = state.league ? `Invite people to ${state.league.name}` : "Invite the family";
    $("#modalcode").textContent = state.league?.passcode || LEAGUE_PASSCODE;
    $("#sharemodal").hidden = false;
  };
  $("#sendinvite").onclick = shareInvite;
  $("#closemodal").onclick = () => { $("#sharemodal").hidden = true; };
  $("#sharemodal").onclick = e => { if (e.target.id === "sharemodal") $("#sharemodal").hidden = true; };
}

async function shareInvite() {
  const code = state.league?.passcode || LEAGUE_PASSCODE;
  const lname = state.league?.name || "Mess With 'Em All";
  const text = `Join our football pick'em league — ${lname}!\n${location.origin + location.pathname}\nPasscode: ${code}`;
  try {
    await navigator.share({ text });
  } catch (e) {
    if (e.name === "AbortError") return;
    $("#sharemodal").hidden = true;
    try {
      await navigator.clipboard.writeText(text);
      $("#banner").textContent = "Invite copied — paste it into a text to the family.";
    } catch {
      $("#banner").textContent = `Share this link with the passcode "${code}": ${location.origin + location.pathname}`;
    }
  }
}

function setView(v) {
  state.view = v;
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  render();
}

function buildWeekStrip() {
  const nav = $("#weeks"); nav.innerHTML = "";
  for (const wk of state.calendar) {
    const b = document.createElement("button");
    b.textContent = wk.label.replace("Week ", "Wk ");
    b.setAttribute("aria-pressed", String(wk.value === state.week));
    b.onclick = () => loadWeek(wk.value);
    nav.appendChild(b);
  }
  nav.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
}

async function loadWeek(week) {
  state.week = week; buildWeekStrip();
  $("#content").innerHTML = `<p class="note">Loading week ${week}…</p>`;
  try {
    state.games = await api.fetchWeek(week);
    state.weekGames.set(week, state.games);
    render();
  } catch {
    $("#content").innerHTML = `<p class="note"><b>Couldn't load the schedule.</b><br>Check your connection and try again.</p>`;
  }
}

async function loadLeague() {
  [state.players, state.picks] = await Promise.all([
    api.listPlayers(state.league.id), api.listAllPicks(state.league.id),
  ]);
}

function showLeagueError(e) {
  console.error(e);
  $("#banner").textContent = "Couldn't reach the league database. Schedule still works; picks and standings won't.";
}

// ---------- render ----------

function render() {
  const entry = state.calendar.find(c => c.value === state.week);
  $("#range").textContent = entry?.end
    ? `${fmtDate(entry.start)} – ${fmtDate(entry.end)}` : "";
  if (state.view === "schedule") renderSchedule();
  else if (state.view === "picks") renderPicks(entry);
  else renderStandings();
  $("#signout").hidden = !state.player;
  $("#who").textContent = state.player ? `${state.player.name} · ${state.league?.name || ""}` : "";
}

function renderSchedule() {
  const el = $("#content"); el.innerHTML = "";
  if (api.isConfigured()) el.innerHTML = `<p class="hint schedtip">This tab is the TV guide — choose your winners on the <b>My picks</b> tab.</p>`;
  groupByKickoff(state.games).forEach(gs => {
    const sec = document.createElement("section"); sec.className = "slot";
    sec.innerHTML = `<h2>${slotLabel(gs[0])}<small>${gs[0].tbd ? "" : dayLabel(gs[0])}</small></h2>`;
    gs.forEach(g => sec.appendChild(gameRow(g)));
    el.appendChild(sec);
  });
}

function gameRow(g) {
  const el = document.createElement("article");
  el.className = `game ${g.state}`;
  const status = g.state === "in" ? `<span class="status live">${g.detail}</span>`
               : g.state === "post" ? `<span class="status">${g.detail}</span>` : "";
  el.innerHTML = `<div class="teams">${teamLine(g.away)}${teamLine(g.home)}</div>
    <div class="meta"><span class="tv">${g.tv}</span>${status}</div>`;
  return el;
}

function teamLine(t) {
  return `<div class="team ${t.winner ? "win" : ""}"><span class="rank">${t.rank || ""}</span>
    <span class="name">${t.name}</span><span class="score">${t.score ?? ""}</span></div>`;
}

// ---------- picks ----------

function renderPicks(entry) {
  const el = $("#content");
  if (!api.isConfigured()) {
    el.innerHTML = `<p class="note"><b>League isn't set up yet.</b><br>Add your Supabase URL and key to js/config.js. See the README.</p>`;
    return;
  }
  if (!state.player || !state.league || state.showJoin) return renderJoin();

  const lock = api.lockTimeFor(entry);
  const mine = new Map(state.picks.filter(p => p.player_id === state.player.id && p.week === state.week).map(p => [p.game_id, p.team_id]));
  const locked = Date.now() >= lock;
  const made = state.games.filter(g => mine.has(g.id)).length;

  el.innerHTML = `<div class="lockbar ${locked ? "locked" : ""}">
    <span>${locked ? "Picks are locked for this week." : `Picks lock ${fmtDateTime(lock)}.`}</span>
    <span>${made} of ${state.games.length} picked</span></div>`;

  // Once a game is locked, everyone's picks are fair to show.
  const nameOf = new Map(state.players.map(p => [p.id, p.name]));
  const byGame = new Map();
  for (const p of state.picks) {
    if (p.week !== state.week) continue;
    const m = byGame.get(p.game_id) || byGame.set(p.game_id, new Map()).get(p.game_id);
    (m.get(p.team_id) || m.set(p.team_id, []).get(p.team_id)).push(nameOf.get(p.player_id) || "?");
  }

  const visible = state.showFinished ? state.games : state.games.filter(g => g.state !== "post");
  const hidden = state.games.length - visible.length;

  groupByKickoff(visible).forEach(gs => {
    const sec = document.createElement("section"); sec.className = "slot";
    sec.innerHTML = `<h2>${slotLabel(gs[0])}<small>${gs[0].tbd ? "" : dayLabel(gs[0])}</small></h2>`;
    gs.forEach(g => sec.appendChild(pickRow(g, mine.get(g.id), api.isGameLocked(g, lock), byGame.get(g.id))));
    el.appendChild(sec);
  });

  if (hidden || state.showFinished) {
    const t = document.createElement("button");
    t.className = "linkbtn togglefinished";
    t.textContent = state.showFinished ? "Hide finished games" : `Show ${hidden} finished game${hidden === 1 ? "" : "s"}`;
    t.onclick = () => { state.showFinished = !state.showFinished; render(); };
    el.appendChild(t);
  }

  const j = document.createElement("button");
  j.className = "linkbtn togglefinished";
  j.textContent = "Join or start another league";
  j.onclick = () => { state.showJoin = true; render(); };
  el.appendChild(j);
}

function pickRow(g, picked, locked, famPicks) {
  const el = document.createElement("article");
  el.className = `game pick ${g.state}`;
  const btn = t => {
    const isPick = picked === t.id;
    const result = g.state === "post" && isPick ? (t.winner ? "right" : "wrong") : "";
    return `<button class="pickbtn ${isPick ? "on" : ""} ${result}" data-team="${t.id}" ${locked ? "disabled" : ""}
      aria-pressed="${isPick}"><span class="rank">${t.rank || ""}</span><span class="name">${t.name}</span>
      <span class="score">${t.score ?? ""}</span></button>`;
  };
  let fam = "";
  if (locked && famPicks) {
    const side = t => { const names = famPicks.get(t.id); return names ? `<b>${esc(t.name)}:</b> ${esc(names.join(", "))}` : ""; };
    const parts = [side(g.away), side(g.home)].filter(Boolean);
    if (parts.length) fam = `<div class="fampicks">${parts.join("&ensp;")}</div>`;
  }
  el.innerHTML = `<div class="pickpair">${btn(g.away)}${btn(g.home)}</div>
    <div class="meta"><span class="tv">${g.tv}</span>
    ${g.state !== "pre" ? `<span class="status ${g.state === "in" ? "live" : ""}">${g.detail}</span>` : `<span class="status">${locked ? "Locked" : ""}</span>`}</div>${fam}`;
  el.querySelectorAll(".pickbtn").forEach(b => b.onclick = () => makePick(g, b.dataset.team));
  return el;
}

async function makePick(g, teamId) {
  const p = state.picks.find(p => p.player_id === state.player.id && p.week === state.week && p.game_id === g.id);
  if (p) p.team_id = teamId; else state.picks.push({ player_id: state.player.id, week: state.week, game_id: g.id, team_id: teamId });
  render();
  try { await api.savePick(state.player.id, state.week, g.id, teamId, state.league.id); }
  catch (e) { $("#banner").textContent = "That pick didn't save. Check your connection and tap it again."; console.error(e); }
}

function renderJoin() {
  $("#content").innerHTML = `${state.player && state.league ? `<p class="hint schedtip"><button type="button" class="linkbtn" id="backtoleague">← Back to ${esc(state.league.name)}</button></p>` : ""}
  <form class="join" id="join">
    <h2>Join a league</h2>
    <label>Your name<input name="name" required autocomplete="off" placeholder="Dad"></label>
    <label>League passcode<input name="code" required autocomplete="off"></label>
    <button type="submit">Join</button>
    <p class="hint">The passcode decides which league you land in. Use the same name every time so your picks stay together.</p>
    <p class="hint">Don't have one? <button type="button" class="linkbtn" id="showcreate">Start a new league</button></p>
  </form>
  <form class="join" id="create" hidden>
    <h2>Start a new league</h2>
    <label>League name<input name="lname" required autocomplete="off" placeholder="The Smith Family"></label>
    <label>Make up a passcode<input name="code" required autocomplete="off" placeholder="something easy to text"></label>
    <label>Your name<input name="name" required autocomplete="off"></label>
    <button type="submit">Create league</button>
    <p class="hint">Only people you give the passcode can get in. You're the first member.</p>
  </form>`;

  const back = $("#backtoleague");
  if (back) back.onclick = () => { state.showJoin = false; render(); };
  $("#showcreate").onclick = () => { $("#join").hidden = true; $("#create").hidden = false; };

  $("#join").onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const code = normCode(f.get("code"));
    const name = f.get("name").trim();
    try {
      const league = await api.getLeague(code);
      if (!league) { $("#banner").textContent = "No league has that passcode. Check the spelling, or start a new league."; return; }
      await joinLeague(league, name);
    } catch (err) { showLeagueError(err); }
  };

  $("#create").onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const lname = f.get("lname").trim();
    const code = normCode(f.get("code"));
    const name = f.get("name").trim();
    if (code.length < 4) { $("#banner").textContent = "Make the passcode at least 4 characters."; return; }
    try {
      const league = await api.createLeague(lname, code);
      await joinLeague(league, name);
    } catch (err) {
      if (String(err.message).includes("409")) $("#banner").textContent = "A league already uses that passcode. If you just created it, reload and use Join with the same passcode — otherwise make up a different one.";
      else showLeagueError(err);
    }
  };
}

async function joinLeague(league, name) {
  // Create the player first, so nothing is saved locally unless the join fully worked.
  const player = await api.getOrCreatePlayer(name, league.id);
  state.league = { id: league.id, name: league.name, passcode: league.passcode };
  state.player = player;
  localStorage.setItem("league", JSON.stringify(state.league));
  localStorage.setItem("player", JSON.stringify(state.player));
  $("#banner").textContent = "";
  state.showJoin = false;
  await loadLeague(); render();
}

const normCode = s => String(s).trim().toLowerCase();

// ---------- standings ----------

async function renderStandings() {
  const el = $("#content");
  if (!api.isConfigured()) { el.innerHTML = `<p class="note">League isn't set up yet — see the README.</p>`; return; }
  if (!state.league) { el.innerHTML = `<p class="note">Join a league on the <b>My picks</b> tab to see its standings.</p>`; return; }
  el.innerHTML = `<p class="note">Adding up the season…</p>`;

  const weeksToScore = [...new Set(state.picks.map(p => p.week))].sort((a, b) => a - b);
  await Promise.all(weeksToScore.filter(w => !state.weekGames.has(w))
    .map(async w => state.weekGames.set(w, await api.fetchWeek(w).catch(() => []))));
  if (state.view !== "standings") return; // the user moved on while we were fetching

  const winners = new Map(); // game_id -> winning team id
  for (const games of state.weekGames.values())
    for (const g of games) if (g.state === "post") winners.set(g.id, g.home.winner ? g.home.id : g.away.id);

  const rows = state.players.map(pl => {
    const mine = state.picks.filter(p => p.player_id === pl.id);
    const byWeek = {};
    let total = 0, decided = 0;
    for (const p of mine) {
      const w = winners.get(p.game_id);
      if (!w) continue;
      decided++;
      byWeek[p.week] = byWeek[p.week] || { right: 0, played: 0 };
      byWeek[p.week].played++;
      if (w === p.team_id) { total++; byWeek[p.week].right++; }
    }
    return { name: pl.name, total, decided, byWeek, thisWeek: byWeek[state.week] };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  if (!rows.length) { el.innerHTML = `<p class="note"><b>Nobody has joined yet.</b><br>Share the link and the passcode.</p>`; return; }

  el.innerHTML = `<table class="standings"><thead><tr><th></th><th>Player</th><th>Season</th><th>This week</th><th>Hit rate</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr class="${state.player && r.name === state.player.name ? "me" : ""}">
      <td class="pos">${i + 1}</td><td>${esc(r.name)}</td><td class="num big">${r.total}</td>
      <td class="num">${r.thisWeek ? `${r.thisWeek.right} / ${r.thisWeek.played}` : "—"}</td>
      <td class="num">${r.decided ? Math.round(100 * r.total / r.decided) + "%" : "—"}</td></tr>`).join("")}</tbody></table>
    <p class="hint">One point per correct pick. Games that haven't finished don't count yet.</p>`;
}

// ---------- helpers ----------

function groupByKickoff(games) {
  const groups = new Map();
  for (const g of games) {
    const key = g.tbd ? "zz" : g.date.toISOString().slice(0, 13) + Math.floor(g.date.getMinutes() / 15);
    (groups.get(key) || groups.set(key, []).get(key)).push(g);
  }
  return [...groups.values()];
}
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtDate = d => new Date(d).toLocaleDateString([], { month: "short", day: "numeric" });
const fmtDateTime = d => d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const slotLabel = g => g.tbd ? "Time to be announced" : g.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayLabel = g => g.date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
