// Fill these in after creating your Supabase project (see README).
export const SUPABASE_URL = "https://fzyfxccwrgxysoeqohlp.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_IWCEz08f1cRC2pkxVPclGw__Qpwaqtn";

// Fallback passcode shown in the share card before you've joined a league.
export const LEAGUE_PASSCODE = "football";

// Shown next to the time zone. Bump on every push so phones can confirm
// they have the latest (old copies can linger ~10 minutes in caches).
export const VERSION = "2.0";

export const SEASON = 2026;

// Picks lock at this time on the Thursday of each week, in this time zone.
// Thursday-night games kick off after this, so nobody can pick after seeing a result.
export const LOCK_HOUR = 12; // noon
export const LOCK_TZ = "America/Denver";

// Weeks listed here skip the Thursday lock — each game still locks at its own
// kickoff. One-off so the family could join mid-week 1; remove after week 1.
export const OPEN_WEEKS = [1];
