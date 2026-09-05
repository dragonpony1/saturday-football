import { SUPABASE_URL, SUPABASE_ANON_KEY, SEASON, LOCK_HOUR, LOCK_TZ, OPEN_WEEKS } from "./config.js";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard";

// ---------- ESPN schedule ----------

const weekCache = new Map();

export async function fetchCalendar() {
  const json = await fetch(`${ESPN}?groups=80&dates=${SEASON}&limit=1`).then(r => r.json());
  const cal = (json.leagues[0].calendar || []).find(c => c.label === "Regular Season");
  return (cal?.entries || []).map(e => ({
    value: +e.value, label: e.label, start: new Date(e.startDate), end: new Date(e.endDate),
  }));
}

export async function fetchWeek(week, { force = false } = {}) {
  const cached = weekCache.get(week);
  if (cached && !force && Date.now() - cached.at < 60_000) return cached.games;
  const res = await fetch(`${ESPN}?groups=80&seasontype=2&dates=${SEASON}&week=${week}&limit=400`);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const games = parseGames(await res.json());
  weekCache.set(week, { games, at: Date.now() });
  return games;
}

function parseGames(json) {
  return (json.events || []).map(ev => {
    const c = ev.competitions[0];
    const side = t => ({
      id: t.team.id,
      name: t.team.shortDisplayName || t.team.displayName,
      full: t.team.displayName,
      rank: t.curatedRank && t.curatedRank.current <= 25 ? t.curatedRank.current : null,
      conf: t.team.conferenceId,     // ESPN conference id; Big 12 is "4"
      score: t.score,
      winner: !!t.winner,
    });
    const tv = (c.broadcasts || []).flatMap(b => b.names || []);
    const geo = (c.geoBroadcasts || []).map(g => g.media?.shortName).filter(Boolean);
    return {
      id: ev.id,
      date: new Date(ev.date),
      tbd: c.timeValid === false,
      home: side(c.competitors.find(t => t.homeAway === "home")),
      away: side(c.competitors.find(t => t.homeAway === "away")),
      tv: [...new Set(tv.length ? tv : geo)].join(" / ") || "TBA",
      state: ev.status.type.state,          // pre | in | post
      detail: ev.status.type.shortDetail,
    };
  }).sort((a, b) => a.date - b.date);
}

// ---------- Lock time ----------

// Returns the Date when picks lock for a week: Thursday at LOCK_HOUR in LOCK_TZ.
// Open weeks stay pickable until the week ends; each game still locks at kickoff.
export function lockTimeFor(weekEntry) {
  if (OPEN_WEEKS.includes(weekEntry.value)) {
    return weekEntry.end ? new Date(weekEntry.end) : new Date(Date.now() + 7 * 864e5);
  }
  const d = new Date(weekEntry.start);
  for (let i = 0; i < 8; i++) {
    const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: LOCK_TZ }).format(d);
    if (wd === "Thu") break;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: LOCK_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  // Try both possible UTC offsets for the zone and keep the one that lands on LOCK_HOUR locally.
  for (const off of ["-06:00", "-07:00", "-05:00", "-08:00", "+00:00"]) {
    const t = new Date(`${ymd}T${String(LOCK_HOUR).padStart(2, "0")}:00:00${off}`);
    const h = +new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: LOCK_TZ }).format(t);
    if (h === LOCK_HOUR) return t;
  }
  return d;
}

export function isGameLocked(game, weekLock) {
  return Date.now() >= weekLock || (!game.tbd && Date.now() >= game.date);
}

// ---------- Supabase (plain REST, no SDK) ----------

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

async function rest(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  // Successful writes often come back with an empty body (200/201, not just 204).
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function isConfigured() {
  return !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR-ANON");
}

export async function getLeagueById(id) {
  const rows = await rest(`leagues?id=eq.${encodeURIComponent(id)}&select=id,name,passcode,pick_mode`);
  return rows[0] || null;
}

export async function getLeague(passcode) {
  const rows = await rest(`leagues?passcode=eq.${encodeURIComponent(passcode)}&select=id,name,passcode,pick_mode`);
  return rows[0] || null;
}

export async function createLeague(name, passcode, pickMode) {
  const created = await rest("leagues", {
    method: "POST", body: JSON.stringify({ name, passcode, pick_mode: pickMode }), headers: { Prefer: "return=representation" },
  });
  return created[0];
}

// For players saved on a phone before leagues existed: look up which league they're in.
export async function getPlayerLeague(playerId) {
  const rows = await rest(`players?id=eq.${encodeURIComponent(playerId)}&select=league_id,leagues(id,name,passcode,pick_mode)`);
  return rows[0]?.leagues || null;
}

export async function getOrCreatePlayer(name, leagueId) {
  const existing = await rest(`players?name=eq.${encodeURIComponent(name)}&league_id=eq.${encodeURIComponent(leagueId)}&select=id,name`);
  if (existing.length) return existing[0];
  const created = await rest("players", {
    method: "POST", body: JSON.stringify({ name, league_id: leagueId }), headers: { Prefer: "return=representation" },
  });
  return created[0];
}

export function listPlayers(leagueId) {
  return rest(`players?league_id=eq.${encodeURIComponent(leagueId)}&select=id,name&order=name`);
}

export function listAllPicks(leagueId) {
  return rest(`picks?season=eq.${SEASON}&league_id=eq.${encodeURIComponent(leagueId)}&select=player_id,week,game_id,team_id`);
}

export function savePick(playerId, week, gameId, teamId, leagueId) {
  return rest("picks", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ player_id: playerId, league_id: leagueId, season: SEASON, week, game_id: gameId, team_id: teamId, updated_at: new Date().toISOString() }),
  });
}
