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
  recapPlayer: null,                // standings row expanded into a week recap
  infoOpen: new Set(),              // game ids with the info snapshot expanded
  followGame: localStorage.getItem("followGame") || null, // play-by-play on the ticker
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
  setTimeout(maybeInstallTip, 2000); // give the join greeting first claim on the banner
  setInterval(refreshChat, 30_000); // keep the league chat fresh while it's on screen
  setInterval(liveTick, 60_000);    // live scores + standings while the app is open
  setInterval(updateChatPulse, 45_000); updateChatPulse(); // chat ribbon + unread badge
  const now = Date.now();
  const cur = state.calendar.find(c => c.end && now >= c.start && now <= c.end)
           || state.calendar.find(c => c.end && now < c.end) || state.calendar[0];
  state.week = cur.value;
  state.nowWeek = cur.value; // the real-life week, for the live-score ticker
  buildWeekStrip();
  updateScoreTicker();
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
    if (state.player) {
      const standalone = matchMedia("(display-mode: standalone)").matches || !!navigator.standalone;
      api.touchPlayer(state.player.id, standalone).catch(() => {});
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

// Android lets us pop the real install prompt; grab it when the browser offers.
let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; });

// This player's tie-breaker roll for the current week, from the chat log.
async function myRollThisWeek() {
  const entry = state.calendar.find(c => c.value === state.week);
  const since = entry?.start ? new Date(entry.start).toISOString() : new Date(0).toISOString();
  const rolls = await api.listRolls(state.league.id, since);
  return rolls.find(r => r.player_id === state.player.id) || null;
}

// The roll button says where you stand: ready to roll, or locked in.
async function updateRollBtn() {
  if (!$("#rollbtn")) return;
  try {
    const mine = await myRollThisWeek();
    const btn = $("#rollbtn");
    if (!btn || state.view !== "standings") return;
    if (mine) {
      btn.textContent = `🎲 Locked in: ${(mine.body.match(/rolled (\d+)/) || [])[1]}`;
      btn.disabled = true;
    } else {
      btn.textContent = "🎲 Roll your tie-breaker";
      btn.disabled = false;
    }
  } catch {}
}

// The live-scores ticker: ranked games while the slate is busy, everything
// that's on when it isn't.
function updateScoreTicker() {
  const bar = $("#scoreticker");
  if (!bar) return;
  const games = state.weekGames.get(state.nowWeek) || (state.week === state.nowWeek ? state.games : []) || [];
  const live = games.filter(g => g.state === "in");
  const ranked = live.filter(g => g.home.rank || g.away.rank);
  const followed = state.followGame ? live.find(g => g.id === state.followGame) : null;
  if (state.followGame && !followed) { state.followGame = null; localStorage.removeItem("followGame"); } // game over
  const show = (ranked.length >= 2 ? ranked : live).filter(g => g !== followed).slice(0, 12);
  if (!show.length && !followed) { bar.hidden = true; return; }
  const rk = t => t.rank ? `#${t.rank} ` : "";
  let lead = "";
  if (followed) {
    const g = followed;
    lead = `<b class="followseg">📻 ${rk(g.away)}${esc(g.away.name)} ${g.away.score ?? 0}–${g.home.score ?? 0} ${rk(g.home)}${esc(g.home.name)} (${esc(g.detail)})${g.sit?.dd ? ` · ${esc(g.sit.dd)}` : ""}${g.sit?.last ? ` · ${esc(g.sit.last)}` : ""}</b>${show.length ? "&ensp;•&ensp;" : ""}`;
  }
  // Upset alert: an unranked team leading a ranked one, live.
  const isUpset = g => {
    const rankedSide = g.away.rank && !g.home.rank ? g.away : g.home.rank && !g.away.rank ? g.home : null;
    if (!rankedSide) return false;
    const other = rankedSide === g.away ? g.home : g.away;
    return (+other.score || 0) > (+rankedSide.score || 0);
  };
  bar.hidden = false;
  $("#scoretext").innerHTML = lead + show.map(g => {
    const txt = `${rk(g.away)}${esc(g.away.name)} ${g.away.score ?? 0}–${g.home.score ?? 0} ${rk(g.home)}${esc(g.home.name)} (${esc(g.detail)})`;
    return isUpset(g) ? `<span class="upset">🚨 UPSET ALERT: ${txt}</span>` : `🏈 ${txt}`;
  }).join("&ensp;•&ensp;");
}

// The chat ribbon at the top and the unread badge on the League tab.
// Every few rotations it moonlights as a home-screen ad for the uninstalled.
let pulseCount = 0;
async function updateChatPulse() {
  const bar = $("#ticker");
  if (!state.league || !api.isConfigured()) { if (bar) bar.hidden = true; return; }
  try {
    const msgs = await api.listMessages(state.league.id);
    const last = msgs[msgs.length - 1];
    pulseCount++;
    const standalone = matchMedia("(display-mode: standalone)").matches || !!navigator.standalone;
    const showTip = !standalone && pulseCount % 5 === 2;
    state.tickerTip = showTip;
    if (bar) {
      if (showTip) {
        bar.hidden = false;
        $("#tickertext").textContent = "📲 Make it feel like a real app: add it to your home screen — tap here to see how";
      } else {
        bar.hidden = !last;
        if (last) $("#tickertext").textContent = `💬 ${last.players?.name || "?"}: ${last.body}`;
      }
    }
    const seen = +localStorage.getItem("chatread-" + state.league.id) || 0;
    const unread = msgs.filter(m => new Date(m.created_at).getTime() > seen).length;
    const tab = document.querySelector('[data-view="standings"]');
    if (tab) tab.textContent = unread ? `League 💬${unread}` : "League";
  } catch {} // quiet: the ribbon just tries again next round
}
function maybeInstallTip() {
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) return;
  if (localStorage.getItem("a2hs-done")) return;
  const b = $("#banner");
  if (b.textContent) return; // something more important is showing
  const done = () => { localStorage.setItem("a2hs-done", "1"); b.textContent = ""; };
  const tip = document.createElement("button");
  tip.className = "linkbtn";
  tip.textContent = "📲 Tip: put this app on your home screen — tap for how";
  tip.onclick = () => {
    done();
    if (installPrompt) { installPrompt.prompt(); installPrompt = null; return; }
    $("#modaltitle").textContent = state.league ? `Invite people to ${state.league.name}` : "Invite the family";
    $("#modalcode").textContent = state.league?.passcode || LEAGUE_PASSCODE;
    $("#sharemodal").hidden = false;
    $("#a2hs").click(); // reveal the how-to steps right away
  };
  const no = document.createElement("button");
  no.className = "linkbtn";
  no.textContent = "no thanks";
  no.onclick = done;
  b.append(tip, " · ", no);
}

function bindNav() {
  // Already on the home screen? No need to offer it.
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) $("#a2hs").hidden = true;
  $("#a2hs").onclick = () => {
    if (installPrompt) { installPrompt.prompt(); installPrompt = null; return; }
    const steps = $("#a2hssteps");
    steps.hidden = false;
    steps.innerHTML = /iPhone|iPad|iPod/.test(navigator.userAgent)
      ? `On an iPhone: tap the <b>Share</b> button at the bottom of the browser (the square with the arrow pointing up), scroll down, tap <b>Add to Home Screen</b>, then tap <b>Add</b>. The 🏈 icon lands on your home screen.`
      : `Open your browser's menu (the <b>⋮</b> in the corner) and tap <b>Add to home screen</b> or <b>Install app</b>.`;
  };
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
  $("#who").onclick = () => { state.showJoin = true; setView("picks"); };
  $("#scoreticker").onclick = () => { setView("schedule"); if (state.week !== state.nowWeek) loadWeek(state.nowWeek); };
  $("#ticker").onclick = () => {
    if (state.tickerTip) {
      if (installPrompt) { installPrompt.prompt(); installPrompt = null; return; }
      $("#modaltitle").textContent = state.league ? `Invite people to ${state.league.name}` : "Invite the family";
      $("#modalcode").textContent = state.league?.passcode || LEAGUE_PASSCODE;
      $("#sharemodal").hidden = false;
      $("#a2hs").click();
      return;
    }
    setView("standings"); setTimeout(() => document.querySelector(".chat")?.scrollIntoView({ behavior: "smooth" }), 400);
  };
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
  $("#closegame").onclick = () => { $("#gamemodal").hidden = true; };
  $("#gamemodal").onclick = e => { if (e.target.id === "gamemodal") $("#gamemodal").hidden = true; };
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
    updateScoreTicker(); // wake the ticker as soon as games load, not a minute later
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
    <div class="meta"><span class="tv">${g.tv}</span>${status}${infoBtnHtml()}</div>`;
  bindInfoBtn(el, g);
  return el;
}

// The ⓘ button opens the full scouting-report page for a game.
function infoBtnHtml() { return `<button type="button" class="infobtn">ⓘ game info</button>`; }
function bindInfoBtn(el, g) {
  const b = el.querySelector(".infobtn");
  if (b) b.onclick = () => openGameInfo(g);
}

const bigLogo = t => t.logo ? `<img class="glogo" src="${t.logo}" alt="" onerror="this.hidden=true">` : "";

async function openGameInfo(g) {
  const box = $("#gamedetail");
  $("#gamemodal").hidden = false;
  const rk = t => t.rank ? `#${t.rank} ` : "";
  const head = `<div class="gvs">
      <div class="gteam">${bigLogo(g.away)}<b>${rk(g.away)}${esc(g.away.name)}</b><small>${esc(g.away.rec || "")}</small></div>
      <div class="gat">at</div>
      <div class="gteam">${bigLogo(g.home)}<b>${rk(g.home)}${esc(g.home.name)}</b><small>${esc(g.home.rec || "")}</small></div>
    </div>
    <p class="hint gmeta">${g.state !== "pre" ? esc(g.detail) + " · " : ""}${g.tbd ? "Time TBA" : g.date.toLocaleString([], { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${esc(g.tv)}</p>
    ${g.state === "in" ? `<p class="gmeta"><button type="button" id="followbtn" class="linkbtn"></button></p>` : ""}`;
  box.innerHTML = head + `<p class="hint">Pulling the scouting report…</p>`;
  bindFollowBtn(g);

  let extra = "";
  try {
    const s = await api.fetchGameSummary(g.id);
    const friendlyLine = l => { const m = /^(.+?)\s*-([\d.]+)$/.exec(l || ""); return m ? `${m[1]} by ${m[2]}` : l; };
    const ouLine = ou => ou ? `Vegas expect${g.state === "post" ? "ed" : "s"} about <b>${ou} total points</b>${ou >= 62 ? " — could be a shootout 🎆" : ou <= 42 ? " — a defensive slugfest 🧱" : ""}` : "";
    const line = g.line || s.pcLine;
    const ou = g.ou || s.pcOu;
    if (s.proj?.home != null && s.proj?.away != null) {
      const fav = s.proj.home >= s.proj.away ? g.home : g.away;
      const pct = Math.round(Math.max(s.proj.home, s.proj.away));
      extra += `<h4>Who's favored</h4>
        <p><b>${esc(fav.name)}</b> — ${pct}% to win, says ESPN's computer${line ? `. Vegas picks <b>${esc(friendlyLine(line))}</b> points.` : ""}</p>
        ${ou ? `<p>${ouLine(ou)}</p>` : ""}
        <div class="projbar"><div style="width:${Math.round(s.proj.away)}%"></div></div>
        <p class="hint">${esc(g.away.name)} ${Math.round(s.proj.away)}% · ${Math.round(s.proj.home)}% ${esc(g.home.name)}</p>`;
    } else if (line) {
      extra += `<h4>The line</h4><p>Vegas ${g.state === "post" ? "had" : "picks"} <b>${esc(friendlyLine(line))}</b> points.${ou ? ` ${ouLine(ou)}` : ""}</p>`;
    }
    const pl = [];
    for (const t of s.leaders || []) {
      const team = t.teamId === g.home.id ? g.home : t.teamId === g.away.id ? g.away : null;
      for (const e of t.entries.slice(0, 2)) {
        pl.push(`<b>${esc(e.name || "?")}</b>${team ? ` (${esc(team.name)})` : ""} — ${esc(e.label)}: ${esc(e.stat)}`);
      }
    }
    if (pl.length) extra += `<h4>Players to watch</h4><p>${pl.join("<br>")}</p>`;
    if (s.article?.headline) extra += `<h4>The story</h4><p><b>${esc(s.article.headline)}</b>${s.article.description ? `<br>${esc(s.article.description)}` : ""}</p>`;
    const bits = [];
    if (g.venue) bits.push(`📍 ${esc(g.venue)}`);
    const w = s.weather || g.weather; if (w) bits.push(`🌤 ${esc(w)}`);
    if (s.attendance) bits.push(`👥 ${Number(s.attendance).toLocaleString()} fans`);
    if (bits.length) extra += `<p class="hint">${bits.join(" · ")}</p>`;
    if (!extra) extra = `<p class="hint">No scouting data on this one — pick with your gut.</p>`;
  } catch (e) { extra = `<p class="hint">Couldn't reach the scouting report. Try again in a minute.</p>`; console.error(e); }
  if (!$("#gamemodal").hidden) { box.innerHTML = head + extra; bindFollowBtn(g); }
}

// Follow one live game: its play-by-play leads the black ticker.
function bindFollowBtn(g) {
  const b = $("#followbtn");
  if (!b) return;
  const label = () => b.textContent = state.followGame === g.id ? "📻 On the ticker — tap to stop" : "📻 Follow this game on the ticker";
  label();
  b.onclick = () => {
    if (state.followGame === g.id) { state.followGame = null; localStorage.removeItem("followGame"); }
    else { state.followGame = g.id; localStorage.setItem("followGame", g.id); }
    label();
    updateScoreTicker();
  };
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
    ${g.state !== "pre" ? `<span class="status ${g.state === "in" ? "live" : ""}">${g.detail}</span>` : `<span class="status">${locked ? "Locked" : ""}</span>`}${infoBtnHtml()}</div>${fam}`;
  el.querySelectorAll(".pickbtn").forEach(b => b.onclick = () => makePick(g, b.dataset.team));
  bindInfoBtn(el, g);
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
      <li><b>Tied?</b> The 🎲 tie-breaker button on the League tab posts a public roll (1–100) into the chat. <b>One roll per week, locked in</b> — highest roll wins, no take-backs.</li>
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
    return { id: pl.id, name: pl.name, total, decided, byWeek, thisWeek: byWeek[state.week] };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  return rows.length
    ? `<table class="standings"><thead><tr><th></th><th>Player</th><th>Season</th><th>This week</th><th>Hit rate</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-pid="${r.id}" class="${state.player && r.name === state.player.name ? "me" : ""}">
        <td class="pos">${i + 1}</td><td>${esc(r.name)}</td><td class="num big">${r.total}</td>
        <td class="num">${r.thisWeek ? `${r.thisWeek.right} / ${r.thisWeek.played}` : "—"}</td>
        <td class="num">${r.decided ? Math.round(100 * r.total / r.decided) + "%" : "—"}</td></tr>
        ${state.recapPlayer === r.id ? `<tr class="recaprow"><td colspan="5">${recapHtml(r.id)}</td></tr>` : ""}`).join("")}</tbody></table>
      <p class="hint">One point per correct pick, live as games finish. Tap any player for their week.</p>`
    : `<p class="note"><b>Nobody has joined yet.</b><br>Share the link and the passcode.</p>`;
}

// One player's report card for the week on screen: hits, misses, and what's pending.
function recapHtml(pid) {
  const games = state.weekGames.get(state.week) || [];
  const picks = new Map(state.picks.filter(p => p.player_id === pid && p.week === state.week).map(p => [p.game_id, p.team_id]));
  const lines = [];
  let pending = 0;
  for (const g of games) {
    const teamId = picks.get(g.id);
    if (!teamId) continue;
    const mine = g.home.id === teamId ? g.home : g.away;
    const other = g.home.id === teamId ? g.away : g.home;
    if (g.state === "post") {
      lines.push(`<span class="${mine.winner ? "rgt" : "wrg"}">${mine.winner ? "✓" : "✗"}</span> ${esc(mine.name)} ${mine.winner ? "beat" : "lost to"} ${esc(other.name)} ${mine.score}–${other.score}`);
    } else pending++;
  }
  return `${lines.length ? lines.join("<br>") : "No finished picks yet this week."}
    ${pending ? `<div class="hint">${pending} pick${pending === 1 ? "" : "s"} still riding on games to come.</div>` : ""}`;
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
    <section class="chat"><h3>League chat <button type="button" id="rollbtn" class="linkbtn">🎲 Tie-breaker roll</button></h3><div id="chatlist"><p class="hint">Loading…</p></div>
    <form id="chatform"><input name="body" maxlength="300" placeholder="Talk your talk…" autocomplete="off" required>
    <button type="submit">Send</button></form></section>`;

  $("#picbtn").onclick = () => $("#picfile").click();
  $("#picfile").onchange = uploadLeaguePhoto;

  // Tap a standings row to unfold that player's week; tap again to fold it.
  $("#standingsbox").onclick = e => {
    const tr = e.target.closest("tr[data-pid]");
    if (!tr) return;
    state.recapPlayer = state.recapPlayer === tr.dataset.pid ? null : tr.dataset.pid;
    $("#standingsbox").innerHTML = standingsHtml();
  };

  // A public dice roll: one per player per week, locked in. The chat log is
  // the record, so it can't be redone from another phone either.
  $("#rollbtn").onclick = async () => {
    try {
      const mine = await myRollThisWeek();
      if (mine) {
        const n = (mine.body.match(/rolled (\d+)/) || [])[1];
        $("#banner").textContent = `Your tie-breaker is locked in for this week: ${n}. One roll per week.`;
        updateRollBtn();
        return;
      }
      if (!confirm(`Roll your one-and-only week ${state.week} tie-breaker? The number locks in and posts to the chat.`)) return;
      const n = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 100);
      await api.sendMessage(state.player.id, state.league.id, `🎲 rolled ${n} (week ${state.week} tie-breaker)`);
      await refreshChat(true);
      updateRollBtn();
    } catch (e) { $("#banner").textContent = "The roll didn't post. Try again."; console.error(e); }
  };
  updateRollBtn();

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
    if (state.nowWeek && state.nowWeek !== state.week) {
      state.weekGames.set(state.nowWeek, await api.fetchWeek(state.nowWeek, { force: true }));
    }
    updateScoreTicker();
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
    // Looking at the chat counts as reading it.
    localStorage.setItem("chatread-" + leagueId, String(Date.now()));
    const tab = document.querySelector('[data-view="standings"]');
    if (tab) tab.textContent = "League";
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
