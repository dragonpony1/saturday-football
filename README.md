# Mess With 'Em All

The family league app (formerly "Saturday Football" — the repo keeps that name).

A family college football app: every week's FBS schedule with kickoff times and TV networks, plus a pick'em league where everyone picks the winner of every game before Thursday at noon. One point per correct pick.

No build step, no framework. Plain HTML/CSS/JS hosted on GitHub Pages, with Supabase holding the picks.

## Setup (about 15 minutes)

### 1. Supabase (stores picks)
1. Go to supabase.com, create a free account and a new project.
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it.
3. Open **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
4. Paste both into `js/config.js`. Change `LEAGUE_PASSCODE` to something your family will know.

### 2. GitHub Pages (hosts the site)
1. Create a new GitHub repo and push this folder to it.
2. In the repo, open **Settings → Pages**. Under *Build and deployment*, set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
3. After a minute your site is live at `https://<your-username>.github.io/<repo-name>/`.

Share that link and the passcode with the family. Everyone joins with their name on the **My picks** tab.

### 3. Working on it with Claude Code
Open this folder in Claude Code and just describe what you want changed. `CLAUDE.md` tells it how the project is laid out.

## How picks work
- Each week, every FBS game appears on **My picks**. Tap a team to pick it. Picks save instantly.
- Picks lock Thursday at noon Mountain (set in `js/config.js`). Any game that kicks off earlier locks at kickoff.
- **Standings** counts one point per correct pick across the season. Unfinished games don't count yet.

## Notes
- Schedule and scores come from ESPN's public scoreboard feed. If ESPN changes it, `js/api.js` is the only file that cares.
- The anon key in `config.js` is meant to be public; the passcode is the only thing keeping strangers out. Don't store anything private in this database.
- Names are the identity. If someone joins as "Dad" on one phone and "dad" on another, that's two players.
