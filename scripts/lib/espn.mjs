/**
 * Client for ESPN's public site API (site.api.espn.com) — undocumented but
 * widely used, no key required, no rate limiting observed under normal use.
 * Unlike SofaScore, it doesn't block datacenter/CI IPs.
 *
 * Upcoming fixtures come from a day-by-day scoreboard sweep (there's no
 * "next N" endpoint). Recent team form comes from each team's own schedule
 * endpoint instead of a wider day sweep — early in a season that endpoint
 * alone doesn't have enough finished matches, so it falls back to the
 * previous season and bridges the two, rather than reporting everything as
 * "low sample" for the first couple of months.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

export const LEAGUES = [
  { slug: 'eng.1', name: 'Premier League', country: 'England' },
  { slug: 'eng.2', name: 'Championship', country: 'England' },
  { slug: 'esp.1', name: 'La Liga', country: 'Spain' },
  { slug: 'ger.1', name: 'Bundesliga', country: 'Germany' },
  { slug: 'ger.2', name: '2. Bundesliga', country: 'Germany' },
  { slug: 'ita.1', name: 'Serie A', country: 'Italy' },
  { slug: 'fra.1', name: 'Ligue 1', country: 'France' },
  { slug: 'tur.1', name: 'Turkish Süper Lig', country: 'Turkey' },
  { slug: 'ned.1', name: 'Eredivisie', country: 'Netherlands' },
  { slug: 'bel.1', name: 'Belgian Pro League', country: 'Belgium' },
  { slug: 'por.1', name: 'Primeira Liga', country: 'Portugal' },
];

/** European season labels run by start year (e.g. 2026 for the 2026-27 season). */
function currentSeasonYear(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month >= 7 ? year : year - 1;
}

const yyyymmdd = (date) => date.toISOString().slice(0, 10).replace(/-/g, '');

async function apiGet(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`ESPN ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function pool(items, worker, limit) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx]);
      } catch (err) {
        out[idx] = { __error: String(err.message || err) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

/** Upcoming fixtures for a league, swept day-by-day over a future window. */
async function fetchUpcomingFixtures(league, futureDays, concurrency) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dates = Array.from({ length: futureDays + 1 }, (_, d) => new Date(today.getTime() + d * 86_400_000));

  const results = await pool(dates, (date) => apiGet(`/${league.slug}/scoreboard?dates=${yyyymmdd(date)}`), concurrency);

  const fixtures = [];
  const seen = new Set();
  for (const day of results) {
    if (!Array.isArray(day?.events)) continue; // __error entries from pool()
    for (const event of day.events) {
      if (seen.has(event.id)) continue;
      const comp = event.competitions?.[0];
      if (comp?.status?.type?.state !== 'pre') continue;
      const competitors = comp.competitors || [];
      const home = competitors.find((c) => c.homeAway === 'home');
      const away = competitors.find((c) => c.homeAway === 'away');
      if (!home || !away) continue;
      seen.add(event.id);
      fixtures.push({
        id: event.id,
        date: event.date,
        league: league.name,
        leagueCountry: league.country,
        home: { id: home.team.id, name: home.team.displayName },
        away: { id: away.team.id, name: away.team.displayName },
      });
    }
  }
  return fixtures;
}

function parseFinishedMatches(events, teamId) {
  const out = [];
  for (const event of events) {
    const comp = event.competitions?.[0];
    if (comp?.status?.type?.state !== 'post') continue;
    const competitors = comp.competitors || [];
    const home = competitors.find((c) => c.homeAway === 'home');
    const away = competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    const gh = Number(home.score?.value ?? home.score);
    const ga = Number(away.score?.value ?? away.score);
    if (!Number.isFinite(gh) || !Number.isFinite(ga)) continue;
    const isHome = home.team.id === teamId;
    out.push({
      date: event.date,
      venue: isHome ? 'home' : 'away',
      gf: isHome ? gh : ga,
      ga: isHome ? ga : gh,
    });
  }
  return out;
}

/**
 * A team's most recent finished matches, bridging into the previous season
 * when the current one doesn't have enough played yet.
 */
async function fetchTeamForm(leagueSlug, teamId, season, minMatches = 10, keep = 15) {
  const current = await apiGet(`/${leagueSlug}/teams/${teamId}/schedule?season=${season}`);
  let matches = parseFinishedMatches(current.events || [], teamId);

  if (matches.length < minMatches) {
    const previous = await apiGet(`/${leagueSlug}/teams/${teamId}/schedule?season=${season - 1}`);
    matches = [...parseFinishedMatches(previous.events || [], teamId), ...matches];
  }

  matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  return matches.slice(-keep).map(({ venue, gf, ga }) => ({ venue, gf, ga }));
}

/**
 * @param {{slug: string, name: string, country: string}} league
 * @returns {{ fixtures: object[], matchesByTeam: Map<string, {venue, gf, ga}[]> }}
 */
export async function fetchLeagueWindow(league, { futureDays = 10, concurrency = 6 } = {}) {
  const fixtures = await fetchUpcomingFixtures(league, futureDays, concurrency);
  const season = currentSeasonYear();

  const teamIds = [...new Set(fixtures.flatMap((f) => [f.home.id, f.away.id]))];
  const results = await pool(teamIds, (id) => fetchTeamForm(league.slug, id, season), concurrency);

  const matchesByTeam = new Map();
  teamIds.forEach((id, i) => {
    if (Array.isArray(results[i])) matchesByTeam.set(id, results[i]);
  });

  return { fixtures, matchesByTeam };
}
