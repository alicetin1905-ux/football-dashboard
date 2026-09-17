/**
 * Client for ESPN's public site API (site.api.espn.com) — undocumented but
 * widely used, no key required, no rate limiting observed under a 20-request
 * burst. Unlike SofaScore, it doesn't block datacenter/CI IPs.
 *
 * There's no single "whole season" endpoint like football-data.org's
 * competition-matches call, so this sweeps day-by-day scoreboard requests
 * across a window (past days for recent form, future days for upcoming
 * fixtures) and derives both from the same data.
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
];

const yyyymmdd = (date) => date.toISOString().slice(0, 10).replace(/-/g, '');

async function fetchDay(leagueSlug, date) {
  const url = `${BASE}/${leagueSlug}/scoreboard?dates=${yyyymmdd(date)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${leagueSlug} ${yyyymmdd(date)} -> HTTP ${res.status}`);
  const body = await res.json();
  return body.events || [];
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

/**
 * @param {{slug: string, name: string, country: string}} league
 * @param {{pastDays: number, futureDays: number, concurrency: number}} opts
 * @returns {{ fixtures: object[], matchesByTeam: Map<string, {venue, gf, ga}[]> }}
 */
export async function fetchLeagueWindow(league, { pastDays = 21, futureDays = 10, concurrency = 6 } = {}) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dates = [];
  for (let d = -pastDays; d <= futureDays; d++) {
    dates.push(new Date(today.getTime() + d * 86_400_000));
  }

  const results = await pool(dates, (date) => fetchDay(league.slug, date), concurrency);

  const fixtures = [];
  const seenFixtureIds = new Set();
  const matchesByTeam = new Map();
  const addMatch = (teamId, entry) => {
    if (!matchesByTeam.has(teamId)) matchesByTeam.set(teamId, []);
    matchesByTeam.get(teamId).push(entry);
  };

  for (const dayEvents of results) {
    if (!Array.isArray(dayEvents)) continue; // __error entries from pool()
    for (const event of dayEvents) {
      const comp = event.competitions?.[0];
      const state = comp?.status?.type?.state;
      const competitors = comp?.competitors || [];
      const home = competitors.find((c) => c.homeAway === 'home');
      const away = competitors.find((c) => c.homeAway === 'away');
      if (!home || !away) continue;

      if (state === 'post') {
        const gh = Number(home.score);
        const ga = Number(away.score);
        if (Number.isFinite(gh) && Number.isFinite(ga)) {
          addMatch(home.team.id, { venue: 'home', gf: gh, ga });
          addMatch(away.team.id, { venue: 'away', gf: ga, ga: gh });
        }
      } else if (state === 'pre' && !seenFixtureIds.has(event.id)) {
        seenFixtureIds.add(event.id);
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
  }

  // dates[] (and therefore results[]) is chronological, so each team's list
  // is already oldest-to-newest — slice(-15) keeps its most recent matches.
  for (const [id, list] of matchesByTeam) {
    matchesByTeam.set(id, list.slice(-15));
  }

  return { fixtures, matchesByTeam };
}
