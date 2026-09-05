# Mess With 'Em All — project guide

The app is named "Mess With 'Em All"; the repo and folder keep the name saturday-football.

Family college football schedule + pick'em league. Static site (GitHub Pages) + Supabase.
The owner is newer to coding and often works from an iPad: keep changes small, explain what you changed in plain language, and don't introduce build tools or frameworks.

## Layout
- `index.html` — page shell: header, Schedule / My picks / Standings tabs, week strip.
- `js/config.js` — Supabase URL + anon key, league passcode, season, lock time. The only file with settings.
- `js/api.js` — all data access. ESPN scoreboard fetch/parse, lock-time math, Supabase REST calls (plain `fetch`, no SDK).
- `js/app.js` — state and rendering for the three views.
- `css/style.css` — styles. Palette: deep blue `--field`, chalk `--chalk`, crimson `--line` (red-and-blue theme, Big 12 country).
- `supabase/schema.sql` — tables `players` and `picks`, with open RLS policies.

## Rules of the league (don't change without asking)
- Each league picks the games on its board (`leagues.pick_mode`: `all` FBS games, `ranked` matchups, or `big12ranked` = Big 12 teams + ranked), 1 point per correct pick.
- Every game locks at its own kickoff; there is no weekly lock time.
- Player identity is just a name + shared passcode. It's a family app, not a secure one.

## Conventions
- Bump `VERSION` in `js/config.js` on every push — it shows next to the time zone so Matt can tell if his phone has the latest.
- ES modules, no bundler. Test by opening `index.html` through any static server (e.g. `python3 -m http.server`).
- ESPN data shape is only touched in `api.js`'s `parseGames`. Everywhere else uses the normalized game object: `{ id, date, tbd, home, away, tv, state, detail }`, where `state` is `pre | in | post`.
- Times are displayed in the viewer's local zone via `toLocale*` — don't hard-code Mountain time except for the lock.
- Keep the UI text in sentence case and plain words.
