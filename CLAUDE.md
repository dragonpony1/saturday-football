# Saturday Football — project guide

Family college football schedule + pick'em league. Static site (GitHub Pages) + Supabase.
The owner is newer to coding and often works from an iPad: keep changes small, explain what you changed in plain language, and don't introduce build tools or frameworks.

## Layout
- `index.html` — page shell: header, Schedule / My picks / Standings tabs, week strip.
- `js/config.js` — Supabase URL + anon key, league passcode, season, lock time. The only file with settings.
- `js/api.js` — all data access. ESPN scoreboard fetch/parse, lock-time math, Supabase REST calls (plain `fetch`, no SDK).
- `js/app.js` — state and rendering for the three views.
- `css/style.css` — styles. Palette: field green `--field`, chalk `--chalk`, gold `--line`.
- `supabase/schema.sql` — tables `players` and `picks`, with open RLS policies.

## Rules of the league (don't change without asking)
- Every FBS game is picked, 1 point per correct pick.
- Picks lock Thursday 12:00 in `America/Denver`; games that kick off earlier lock at kickoff.
- Player identity is just a name + shared passcode. It's a family app, not a secure one.

## Conventions
- ES modules, no bundler. Test by opening `index.html` through any static server (e.g. `python3 -m http.server`).
- ESPN data shape is only touched in `api.js`'s `parseGames`. Everywhere else uses the normalized game object: `{ id, date, tbd, home, away, tv, state, detail }`, where `state` is `pre | in | post`.
- Times are displayed in the viewer's local zone via `toLocale*` — don't hard-code Mountain time except for the lock.
- Keep the UI text in sentence case and plain words.
