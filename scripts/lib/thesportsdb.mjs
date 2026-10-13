/**
 * Client for TheSportsDB's free API, for leagues neither ESPN nor
 * football-data.co.uk actually carry — ESPN lists the TFF 1. Lig as
 * `tur.2` but returns no matches or teams for it on any date.
 *
 * The free key caps most endpoints hard (one "next" match, the first 15 of
 * a season), but `eventsround` returns a full matchday, so a league is
 * fetched round by round: this season up to the next unplayed round, plus
 * the tail of last season to fill a team's form window. The free key allows
 * 30 requests a minute, so requests are spaced out and a 429 waits a minute
 * and retries once. No odds or xG here — these leagues run on our model.
 */

const BASE = 'https://www.thesportsdb.com/api/v1/json/123';

export const TSDB_LEAGUES = [
  { tsdbId: '4676', name: 'TFF 1. Lig', country: 'Turkey' },
];
const REQUEST_GAP_MS = 2100;
const MAX_ROUNDS = 46; // the largest 2nd tiers run 24 teams / 46 rounds

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

async function apiGet(path, retried = false) {
  const wait = lastRequest + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const res = await fetch(BASE + path);
  if (res.status === 429 && !retried) {
    await sleep(61_000);
    return apiGet(path, true);
  }
  if (!res.ok) throw new Error(`TheSportsDB ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** "2026-27" style season label for a date, as TheSportsDB names them ("2026-2027"). */
function seasonLabel(date, back = 0) {
  const start = (date.getUTCMonth() + 1 >= 7 ? date.getUTCFullYear() : date.getUTCFullYear() - 1) - back;
  return `${start}-${start + 1}`;
}

/** Team ids are namespaced so they can never collide with an ESPN id. */
const teamId = (id) => `tsdb-${id}`;

function toEvent(e, league) {
  const homeScore = e.intHomeScore == null || e.intHomeScore === '' ? null : Number(e.intHomeScore);
  const awayScore = e.intAwayScore == null || e.intAwayScore === '' ? null : Number(e.intAwayScore);
  return {
    id: `tsdb-${e.idEvent}`,
    date: new Date(`${e.strTimestamp || `${e.dateEvent}T${(e.strTime || '15:00').slice(0, 5)}:00`}Z`).toISOString(),
    league: league.name,
    leagueCountry: league.country,
    finished: homeScore != null && awayScore != null && e.strStatus !== 'NS',
    home: { id: teamId(e.idHomeTeam), name: e.strHomeTeam, score: homeScore },
    away: { id: teamId(e.idAwayTeam), name: e.strAwayTeam, score: awayScore },
  };
}

const roundCache = new Map();

async function fetchRound(league, season, round) {
  const key = `${league.tsdbId}|${season}|${round}`;
  if (!roundCache.has(key)) {
    const json = await apiGet(`/eventsround.php?id=${league.tsdbId}&r=${round}&s=${season}`);
    roundCache.set(key, (json.events || []).map((e) => toEvent(e, league)));
  }
  return roundCache.get(key);
}

/**
 * Same shape as espn.mjs's fetchLeagueWindow: upcoming fixtures within
 * `futureDays`, results from the last `pastDays`, and each team's finished
 * matches (oldest first, with `date`, for the point-in-time backtest).
 * @param {{name: string, country: string, tsdbId: string}} league
 */
export async function fetchTsdbLeagueWindow(league, { futureDays = 10, pastDays = 7, formMatches = 38 } = {}) {
  const now = new Date();
  const current = seasonLabel(now);
  const events = [];

  // This season: walk rounds until two have nothing finished at all — the
  // next matchday and the one after, which a 10-day window can reach. (A
  // round with one postponed match still counts as played.)
  let finishedRounds = 0;
  let unplayedRounds = 0;
  for (let r = 1; r <= MAX_ROUNDS && unplayedRounds < 2; r++) {
    const round = await fetchRound(league, current, r);
    if (!round.length) break;
    events.push(...round);
    if (round.some((e) => e.finished)) finishedRounds = r;
    if (!round.some((e) => e.finished)) unplayedRounds++;
  }

  // Last season's tail: enough rounds that a team can fill its form window.
  const previous = seasonLabel(now, 1);
  const needed = Math.max(0, formMatches - finishedRounds);
  if (needed) {
    let lastRound = 0;
    for (let r = MAX_ROUNDS; r >= 1 && !lastRound; r -= 4) {
      if ((await fetchRound(league, previous, r)).length) lastRound = r;
    }
    while (lastRound && (await fetchRound(league, previous, lastRound + 1)).length) lastRound++;
    for (let r = lastRound; r > Math.max(0, lastRound - needed); r--) events.push(...(await fetchRound(league, previous, r)));
  }

  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  const t = now.getTime();
  const fixtures = unique
    .filter((e) => !e.finished && new Date(e.date).getTime() >= t - 3 * 3_600_000 && new Date(e.date).getTime() <= t + futureDays * 86_400_000)
    .map(({ finished, ...e }) => ({ ...e, home: { id: e.home.id, name: e.home.name }, away: { id: e.away.id, name: e.away.name } }));
  const results = unique
    .filter((e) => e.finished && new Date(e.date).getTime() >= t - pastDays * 86_400_000)
    .map(({ finished, ...e }) => e);

  const matchesByTeam = new Map();
  for (const e of unique.filter((x) => x.finished).sort((a, b) => new Date(a.date) - new Date(b.date))) {
    for (const [side, other, isHome] of [[e.home, e.away, true], [e.away, e.home, false]]) {
      if (!matchesByTeam.has(side.id)) matchesByTeam.set(side.id, []);
      matchesByTeam.get(side.id).push({ id: e.id, date: e.date, venue: isHome ? 'home' : 'away', opp: other.name, gf: side.score, ga: other.score });
    }
  }
  for (const [id, matches] of matchesByTeam) matchesByTeam.set(id, matches.slice(-formMatches));
  return { fixtures, results, matchesByTeam };
}
