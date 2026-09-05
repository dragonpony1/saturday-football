import { LEAGUE_PASSCODE, VERSION } from "./config.js";
import * as api from "./api.js";

const $ = s => document.querySelector(s);
const state = {
  view: "schedule", week: null, calendar: [], games: [],
  player: JSON.parse(localStorage.getItem("player") || "null"),
  league: JSON.parse(localStorage.getItem("league") || "null"),
  memberships: JSON.parse(localStorage.getItem("memberships") || "[]"), // every league joined on this device
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
  checkForUpdate(); setInterval(checkForUpdate, 5 * 60_000);
  setInterval(refreshChat, 30_000); // keep the league chat fresh while it's on screen
  setInterval(liveTick, 60_000);    // live scores + standings while the app is open
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
    // Phones from before the league list existed: seed it with the current league.
    if (state.player && state.league && !state.memberships.some(m => m.league.id === state.league.id)) {
      state.memberships.push({ league: state.league, player: state.player });
      localStorage.setItem("memberships", JSON.stringify(state.memberships));
    }
    if (state.league) {
      // A league can be deleted or have settings changed behind the scenes.
      const fresh = await api.getLeagueById(state.league.id).catch(() => state.league);
      if (!fresh) dropDeadLeague(state.league.id);
      else {
        if (fresh !== state.league) rememberLeague(fresh);
        await loadLeague().catch(showLeagueError);
      }
    }
  }
  await loadWeek(state.week);
})();

// Nudge phones off stale cached copies: if the server has a newer version,
// offer a one-tap refresh instead of waiting out the ~10-minute cache.
// Lives in its own #updatebar so ordinary messages can never crowd it out.
async function checkForUpdate() {
  try {
    const res = await fetch("js/config.js", { cache: "no-store" });
    if (!res.ok) return; // transient server hiccup: leave any showing prompt alone
    const m = (await res.text()).match(/VERSION = "([^"]+)"/);
    if (!m) return;
    const bar = $("#updatebar");
    if (m[1] === VERSION) { if (bar) bar.innerHTML = ""; return; }
    const label = `Update v${m[1]} is ready — tap to get it`;
    const showing = bar?.querySelector(".linkbtn");
    if (showing) { showing.textContent = label; return; } // newer version shipped: refresh the label
    // Mid-rollout, a stale page may not have #updatebar yet — fall back to the
    // shared banner, but only if no other message is using it.
    const target = bar || $("#banner");
    if (!target || (!bar && target.textContent)) return;
    const btn = document.createElement("button");
    btn.className = "linkbtn";
    btn.textContent = label;
    btn.onclick = async () => {
      try {
        await Promise.all(["index.html", "js/config.js", "js/api.js", "js/app.js", "css/style.css"]
          .map(u => fetch(u, { cache: "reload" })));
      } catch {}
      location.reload();
    };
    target.appendChild(btn);
  } catch {} // offline or blocked: try again next interval
}

function bindNav() {
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  $("#who").onclick = () => { state.showJoin = true; setView("picks"); };
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
  const lname = state.league?.name || "Brimhall mess'n";
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
  $("#banner").textContent = ""; // messages are of-the-moment; don't let one linger forever
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
  announceNewPlayers();
}

// Greet returning users with anyone who joined since their last visit.
function announceNewPlayers() {
  if (!state.league) return;
  const key = "seen-" + state.league.id;
  const seen = JSON.parse(localStorage.getItem(key) || "null");
  const names = state.players.map(p => p.name).sort();
  if (seen) {
    const fresh = names.filter(n => !seen.includes(n) && n !== state.player?.name);
    if (fresh.length) $("#banner").textContent = `🎉 New in ${state.league.name}: ${fresh.join(", ")}`;
  }
  localStorage.setItem(key, JSON.stringify(names));
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
  else if (state.view === "rules") renderRules();
  else renderStandings();
  $("#signout").hidden = !state.player;
  $("#who").hidden = !state.player;
  $("#who").textContent = state.player ? `${state.player.name} · ${state.league?.icon || "🏈"} ${state.league?.name || ""} ▾` : "";
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
  return `<div class="team ${t.winner ? "win" : ""}"><span class="rank">${t.rank || ""}</span>${logoImg(t)}
    <span class="name">${t.name}</span><span class="score">${t.score ?? ""}</span></div>`;
}

const logoImg = t => t.logo ? `<img class="tlogo" src="${t.logo}" alt="" loading="lazy" onerror="this.hidden=true">` : `<span class="tlogo"></span>`;

// ---------- picks ----------

function renderPicks(entry) {
  const el = $("#content");
  if (!api.isConfigured()) {
    el.innerHTML = `<p class="note"><b>League isn't set up yet.</b><br>Add your Supabase URL and key to js/config.js. See the README.</p>`;
    return;
  }
  if (!state.player || !state.league || state.showJoin) return renderJoin();

  const mine = new Map(state.picks.filter(p => p.player_id === state.player.id && p.week === state.week).map(p => [p.game_id, p.team_id]));
  const board = state.games.filter(g => onBoard(g, state.league.pick_mode));
  const made = board.filter(g => mine.has(g.id)).length;
  const weekDone = board.length > 0 && board.every(g => g.state === "post");
  const modeLabel = { main: " · main conferences", big12ranked: " · Big 12 + ranked", ranked: " · ranked matchups only" }[state.league.pick_mode] || "";

  el.innerHTML = `<div class="lockbar ${weekDone ? "locked" : ""}">
    <span>${weekDone ? "This week is in the books." : "Each game locks at its kickoff."}</span>
    <span>${made} of ${board.length} picked${modeLabel}</span></div>`;

  // Everyone's picks are public, before and after kickoff — league's choice.
  const nameOf = new Map(state.players.map(p => [p.id, p.name]));
  const byGame = new Map();
  for (const p of state.picks) {
    if (p.week !== state.week) continue;
    const m = byGame.get(p.game_id) || byGame.set(p.game_id, new Map()).get(p.game_id);
    (m.get(p.team_id) || m.set(p.team_id, []).get(p.team_id)).push(nameOf.get(p.player_id) || "?");
  }

  const visible = state.showFinished ? board : board.filter(g => g.state !== "post");
  const hidden = board.length - visible.length;

  groupByKickoff(visible).forEach(gs => {
    const sec = document.createElement("section"); sec.className = "slot";
    sec.innerHTML = `<h2>${slotLabel(gs[0])}<small>${gs[0].tbd ? "" : dayLabel(gs[0])}</small></h2>`;
    gs.forEach(g => sec.appendChild(pickRow(g, mine.get(g.id), api.isGameLocked(g), byGame.get(g.id))));
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
      aria-pressed="${isPick}"><span class="rank">${t.rank || ""}</span>${logoImg(t)}<span class="name">${t.name}</span>
      <span class="score">${t.score ?? ""}</span></button>`;
  };
  let fam = "";
  if (famPicks) {
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
  if (p && p.team_id === teamId) return; // same pick, nothing to do
  if (p) {
    // Guard against fat-fingered changes: switching an existing pick asks first.
    const from = (g.away.id === p.team_id ? g.away : g.home).name;
    const to = (g.away.id === teamId ? g.away : g.home).name;
    if (!confirm(`Change your pick from ${from} to ${to}?`)) return;
  }
  if (p) p.team_id = teamId; else state.picks.push({ player_id: state.player.id, week: state.week, game_id: g.id, team_id: teamId });
  render();
  try { await api.savePick(state.player.id, state.week, g.id, teamId, state.league.id); }
  catch (e) { $("#banner").textContent = "That pick didn't save. Check your connection and tap it again."; console.error(e); }
}

function renderJoin() {
  // Leagues already joined on this device, minus the one currently on screen.
  const mine = state.memberships.filter(m => !state.league || m.league.id !== state.league.id);
  $("#content").innerHTML = `${state.player && state.league ? `<p class="hint schedtip"><button type="button" class="linkbtn" id="backtoleague">← Back to ${esc(state.league.name)}</button> &nbsp;·&nbsp; <button type="button" class="linkbtn" id="renameme">Change my name</button></p>` : ""}
  ${mine.length ? `<div class="join" id="myleagues"><h2>Your leagues</h2>
    ${mine.map(m => `<button type="button" class="leaguebtn" data-league="${m.league.id}">${esc(m.league.icon || "🏈")} ${esc(m.league.name)}<small>as ${esc(m.player.name)} — tap to switch</small></button>`).join("")}
  </div>` : ""}
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
    <label>League emoji (optional)<input name="icon" maxlength="12" autocomplete="off" placeholder="🏈"></label>
    <label>Make up a passcode<input name="code" required autocomplete="off" placeholder="something easy to text"></label>
    <label>Your name<input name="name" required autocomplete="off"></label>
    <label>Games to pick<select name="mode">
      <option value="main">Main conferences + all Big 12 + ranked (about 35 a week)</option>
      <option value="big12ranked">Big 12 + ranked matchups (about 25 a week)</option>
      <option value="ranked">Ranked matchups only (about 20 a week)</option>
      <option value="all">Every FBS game (about 100 a week)</option>
    </select></label>
    <button type="submit">Create league</button>
    <p class="hint">Only people you give the passcode can get in. You're the first member.</p>
  </form>`;

  const back = $("#backtoleague");
  if (back) back.onclick = () => { state.showJoin = false; render(); };
  const rn = $("#renameme");
  if (rn) rn.onclick = async () => {
    const name = (prompt(`What should your name be in ${state.league.name}?`, state.player.name) || "").trim();
    if (!name || name === state.player.name) return;
    try {
      await api.renamePlayer(state.player.id, name);
      state.player = { ...state.player, name };
      localStorage.setItem("player", JSON.stringify(state.player));
      state.memberships = state.memberships.map(m => m.league.id === state.league.id ? { ...m, player: state.player } : m);
      localStorage.setItem("memberships", JSON.stringify(state.memberships));
      state.showJoin = false;
      await loadLeague(); render();
      $("#banner").textContent = `Done — you're ${name} now. Your picks came along.`;
    } catch (e) {
      if (String(e.message).includes("409")) $("#banner").textContent = "That name's already taken in this league — pick a different one.";
      else showLeagueError(e);
    }
  };
  document.querySelectorAll(".leaguebtn").forEach(b => b.onclick = () => {
    const m = state.memberships.find(x => x.league.id === b.dataset.league);
    if (m) switchLeague(m);
  });
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
      const league = await api.createLeague(lname, code, f.get("mode") || "all", iconTrim((f.get("icon") || "").trim()) || "🏈");
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
  state.player = player;
  localStorage.setItem("player", JSON.stringify(state.player));
  state.memberships = state.memberships.filter(m => m.league.id !== league.id);
  state.memberships.push({ league, player });
  rememberLeague(league);
  $("#banner").textContent = "";
  state.showJoin = false;
  await loadLeague(); render();
}

async function switchLeague(m) {
  const fresh = await api.getLeagueById(m.league.id).catch(() => m.league);
  if (!fresh) return dropDeadLeague(m.league.id);
  state.player = m.player;
  localStorage.setItem("player", JSON.stringify(state.player));
  rememberLeague(fresh);
  state.players = []; state.picks = [];
  $("#banner").textContent = "";
  state.showJoin = false;
  render();
  await loadLeague().catch(showLeagueError); render();
}

// Make this the active league and keep localStorage + the memberships list current.
function rememberLeague(league) {
  state.league = { id: league.id, name: league.name, passcode: league.passcode, pick_mode: league.pick_mode || "all", icon: league.icon || "🏈", icon_url: league.icon_url || null };
  localStorage.setItem("league", JSON.stringify(state.league));
  state.memberships = state.memberships.map(m => m.league.id === league.id ? { ...m, league: state.league } : m);
  localStorage.setItem("memberships", JSON.stringify(state.memberships));
}

function dropDeadLeague(leagueId) {
  state.memberships = state.memberships.filter(m => m.league.id !== leagueId);
  localStorage.setItem("memberships", JSON.stringify(state.memberships));
  if (state.league?.id === leagueId) {
    localStorage.removeItem("player"); localStorage.removeItem("league");
    state.player = null; state.league = null; state.players = []; state.picks = [];
  }
  $("#banner").textContent = "That league no longer exists. Pick another from your list, or join one.";
  render();
}

const normCode = s => String(s).trim().toLowerCase();

// Cap an icon at 3 visible characters without slicing an emoji in half.
function iconTrim(s) {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)]
      .slice(0, 3).map(x => x.segment).join("");
  } catch { return s.slice(0, 4); }
}

// ESPN conference ids for the main conferences: ACC, Big 12, Big Ten, SEC, Pac-12, Mountain West.
const MAIN_CONFS = new Set(["1", "4", "5", "8", "9", "17"]);

// Which games a league picks: its whole board, ranked matchups, Big 12 + ranked,
// or main = main-conference matchups + every Big 12 game + anything ranked.
function onBoard(g, mode) {
  const ranked = !!(g.home.rank || g.away.rank);
  if (mode === "ranked") return ranked;
  if (mode === "big12ranked") return ranked || g.home.conf === "4" || g.away.conf === "4";
  if (mode === "main") return ranked || g.home.conf === "4" || g.away.conf === "4"
    || (MAIN_CONFS.has(g.home.conf) && MAIN_CONFS.has(g.away.conf));
  return true;
}

// ---------- rules ----------

function renderRules() {
  $("#content").innerHTML = `<div class="join rules">
    <h2>Rules &amp; scoring</h2>
    <ul>
      <li><b>Pick every game on your league's board.</b> Some leagues pick every FBS game, some just the ranked matchups — My picks shows yours. Tap the team you think wins; it saves by itself.</li>
      <li><b>1 point per correct pick.</b> Most points at the end of the season wins. Ties share the glory.</li>
      <li><b>Every game locks at its own kickoff.</b> Pick or change right up until the ball is in the air.</li>
      <li><b>Changed your mind?</b> You can switch a pick any time before it locks — the app asks first so a stray thumb can't do it.</li>
      <li><b>Everyone's picks show under each game</b> — even before kickoff. Copy at your own risk; the scoreboard remembers who thought of it first.</li>
      <li><b>The League tab</b> holds the standings and the league chat. Standings add up the whole season; games still being played don't count until they're final.</li>
      <li><b>New folks join</b> with the league passcode and their name — same name every time, so picks stay together.</li>
    </ul>
  </div>`;
}

// ---------- standings ----------

function standingsHtml() {
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

  return rows.length
    ? `<table class="standings"><thead><tr><th></th><th>Player</th><th>Season</th><th>This week</th><th>Hit rate</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${state.player && r.name === state.player.name ? "me" : ""}">
        <td class="pos">${i + 1}</td><td>${esc(r.name)}</td><td class="num big">${r.total}</td>
        <td class="num">${r.thisWeek ? `${r.thisWeek.right} / ${r.thisWeek.played}` : "—"}</td>
        <td class="num">${r.decided ? Math.round(100 * r.total / r.decided) + "%" : "—"}</td></tr>`).join("")}</tbody></table>
      <p class="hint">One point per correct pick. Live — points land as each game goes final.</p>`
    : `<p class="note"><b>Nobody has joined yet.</b><br>Share the link and the passcode.</p>`;
}

async function renderStandings() {
  const el = $("#content");
  if (!api.isConfigured()) { el.innerHTML = `<p class="note">League isn't set up yet — see the README.</p>`; return; }
  if (!state.league) { el.innerHTML = `<p class="note">Join a league on the <b>My picks</b> tab to see its standings.</p>`; return; }

  const pic = state.league.icon_url
    ? `<img class="lpic" src="${esc(state.league.icon_url)}" alt="">`
    : `<span class="licon">${esc(state.league.icon || "🏈")}</span>`;
  const head = `<div class="leaguehead">${pic}<h2>${esc(state.league.name)}</h2>
    <button type="button" class="linkbtn" id="picbtn">${state.league.icon_url ? "Change photo" : "Add league photo"}</button>
    <input type="file" id="picfile" accept="image/*" hidden></div>`;

  el.innerHTML = `${head}<div id="standingsbox"><p class="note">Adding up the season…</p></div>
    <section class="chat"><h3>League chat</h3><div id="chatlist"><p class="hint">Loading…</p></div>
    <form id="chatform"><input name="body" maxlength="300" placeholder="Talk your talk…" autocomplete="off" required>
    <button type="submit">Send</button></form></section>`;

  $("#picbtn").onclick = () => $("#picfile").click();
  $("#picfile").onchange = uploadLeaguePhoto;

  $("#chatform").onsubmit = async e => {
    e.preventDefault();
    const input = e.target.body;
    const body = input.value.trim();
    if (!body) return;
    try {
      await api.sendMessage(state.player.id, state.league.id, body);
      input.value = ""; // only clear once the message actually made it
      await refreshChat(true);
    } catch (err) { $("#banner").textContent = "That message didn't send. Try again."; console.error(err); }
  };
  refreshChat(true);

  const weeksToScore = [...new Set(state.picks.map(p => p.week))].sort((a, b) => a - b);
  await Promise.all(weeksToScore.filter(w => !state.weekGames.has(w))
    .map(async w => state.weekGames.set(w, await api.fetchWeek(w).catch(() => []))));
  if (state.view !== "standings") return; // the user moved on while we were fetching
  const box = $("#standingsbox");
  if (box) box.innerHTML = standingsHtml();
}

// The photo becomes the league's face for everyone in it.
async function uploadLeaguePhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  const btn = $("#picbtn");
  if (btn) btn.textContent = "Uploading…";
  try {
    const blob = await shrinkImage(file);
    const url = await api.uploadLeaguePic(state.league.id, blob);
    await api.setLeaguePic(state.league.id, url);
    rememberLeague({ ...state.league, icon_url: url });
    render();
    $("#banner").textContent = "League photo updated for everyone. 📸";
  } catch (err) {
    if (btn) btn.textContent = "Add league photo";
    $("#banner").textContent = "Couldn't use that photo. Try a different one.";
    console.error(err);
  }
}

// Shrink a phone photo to a small square-ish JPEG before uploading.
async function shrinkImage(file, max = 512) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("bad image")), "image/jpeg", 0.85));
}

// Live scoreboard: while the app is on screen, refresh this week's games each
// minute so scores tick and standings points land as games go final.
async function liveTick() {
  if (document.hidden || !state.week || !api.isConfigured()) return;
  try {
    const fresh = await api.fetchWeek(state.week, { force: true });
    state.games = fresh; state.weekGames.set(state.week, fresh);
    if (state.league) await loadLeague().catch(() => {});
  } catch { return; }
  if (state.view === "schedule") renderSchedule();
  else if (state.view === "picks" && state.player && state.league && !state.showJoin) {
    const entry = state.calendar.find(c => c.value === state.week);
    const y = scrollY; renderPicks(entry); scrollTo(0, y);
  } else if (state.view === "standings" && state.league) {
    const box = $("#standingsbox");
    if (box) box.innerHTML = standingsHtml();
  }
}

// Reload the chat list in place (no full re-render). Overlapping calls and
// league switches are guarded by a token so a stale response never paints.
let chatReq = 0;
async function refreshChat(scrollDown = false) {
  if (!state.league || state.view !== "standings") return;
  const leagueId = state.league.id;
  const token = ++chatReq;
  try {
    const msgs = await api.listMessages(leagueId);
    if (token !== chatReq || state.league?.id !== leagueId || state.view !== "standings") return;
    const el = $("#chatlist");
    if (!el) return;
    const key = `${msgs.length}:${msgs[msgs.length - 1]?.created_at || ""}`;
    if (el.dataset.key === key && !scrollDown) return; // nothing new: don't disturb the reader
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = msgs.length
      ? msgs.map(m => `<p class="msg"><b>${esc(m.players?.name || "?")}</b> ${esc(m.body)}
          <span class="mtime">${new Date(m.created_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span></p>`).join("")
      : `<p class="hint">No messages yet — start the trash talk.</p>`;
    el.dataset.key = key;
    if (scrollDown || nearBottom) el.scrollTop = el.scrollHeight;
  } catch (e) { console.error(e); }
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
const slotLabel = g => g.tbd ? "Time to be announced" : g.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayLabel = g => g.date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
