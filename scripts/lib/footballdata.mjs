/**
 * Client for football-data.co.uk's free CSV files: every match of the
 * current and previous season per league, with expected goals (current
 * season onward) and closing odds from several bookmakers including bwin,
 * plus a `fixtures.csv` of upcoming matches with their pre-match odds
 * (refreshed by the site a few days ahead — typically Tuesdays and Fridays).
 *
 * Used for team strength and real odds. ESPN (espn.mjs) stays the source of
 * the fixture schedule itself, since fixtures.csv only reaches a few days
 * out, and covers competitions this site doesn't (UEFA Nations League).
 */

const BASE = 'https://football-data.co.uk';

/** ESPN league name → football-data.co.uk division code. */
export const FD_CODES = {
  'Premier League': 'E0',
  Championship: 'E1',
  'La Liga': 'SP1',
  Bundesliga: 'D1',
  '2. Bundesliga': 'D2',
  'Serie A': 'I1',
  'Ligue 1': 'F1',
  'Turkish Süper Lig': 'T1',
  Eredivisie: 'N1',
  'Belgian Pro League': 'B1',
  'Primeira Liga': 'P1',
};

/**
 * ESPN display name → football-data.co.uk name, for the names normalization
 * alone can't bridge. Deliberately explicit rather than fuzzy: substring
 * matching would pair "Club Brugge" with "Cercle Brugge".
 */
const ALIASES = {
  'Manchester City': 'Man City',
  'Manchester United': 'Man United',
  'Nottingham Forest': "Nott'm Forest",
  'Wolverhampton Wanderers': 'Wolves',
  'Queens Park Rangers': 'QPR',
  'West Bromwich Albion': 'West Brom',
  Internazionale: 'Inter',
  'Karlsruher SC': 'Karlsruhe',
  Braga: 'Sp Braga',
  'Athletic Club': 'Ath Bilbao',
  'Atlético Madrid': 'Ath Madrid',
  Espanyol: 'Espanol',
  Deportivo: 'La Coruna',
  'Real Betis': 'Betis',
  'Celta Vigo': 'Celta',
  'Real Sociedad': 'Sociedad',
  'Rayo Vallecano': 'Vallecano',
  'Racing Santander': 'Santander',
  'Eintracht Frankfurt': 'Ein Frankfurt',
  'FC Cologne': 'FC Koln',
  'Borussia Mönchengladbach': "M'gladbach",
  'Borussia Dortmund': 'Dortmund',
  'Bayer Leverkusen': 'Leverkusen',
  'TSG Hoffenheim': 'Hoffenheim',
  'Stade Rennais': 'Rennes',
  'Paris Saint-Germain': 'Paris SG',
  'Fortuna Sittard': 'For Sittard',
  'NEC Nijmegen': 'Nijmegen',
  'PEC Zwolle': 'Zwolle',
  'Erzurum BB': 'Erzurumspor',
  'Amed SFK': 'Amedspor',
  'Istanbul Basaksehir': 'Buyuksehyr',
  Goztepe: 'Goztep',
  'Sint-Truidense': 'St Truiden',
  'OH Leuven': 'Oud-Heverlee Leuven',
  'Union St.-Gilloise': 'St. Gilloise',
  'Standard Liege': 'Standard',
  'Sporting CP': 'Sp Lisbon',
  'SC Braga': 'Sp Braga',
  'Vitória de Guimaraes': 'Guimaraes',
  'Académico de Viseu': 'Academico Viseu',
};

const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(fc|cf|afc|sc|sv|ac|as|ss|us|cd|ud|rc|sd|ca|fk|sk|bk|vfb|vfl|tsg|rcd|kv|krc|kaa|rsc|club|calcio|de|1|04|05|1899|1846|1909)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Resolves an ESPN team name to the football-data.co.uk name used in a
 * league's CSVs, or null if there's no confident match.
 * @param {string} espnName
 * @param {Set<string>} fdNames every team name present in that league's data
 */
export function matchTeamName(espnName, fdNames) {
  const alias = ALIASES[espnName];
  if (alias && fdNames.has(alias)) return alias;
  if (fdNames.has(espnName)) return espnName;
  const key = norm(espnName);
  const exact = [...fdNames].filter((n) => norm(n) === key);
  if (exact.length === 1) return exact[0];

  // football-data.co.uk mostly drops suffixes ("Ipswich" for "Ipswich Town",
  // "Feyenoord" for "Feyenoord Rotterdam"), so accept a name whose every word
  // appears in ESPN's. If several qualify, the one sharing the most words wins
  // ("Cercle Brugge KSV" → "Cercle Brugge", not "Club Brugge"); a tie is
  // ambiguous and left unmatched rather than guessed.
  const words = new Set(key.split(' '));
  let best = null;
  let bestSize = 0;
  let tied = false;
  for (const n of fdNames) {
    const toks = norm(n).split(' ').filter(Boolean);
    if (!toks.length || !toks.every((t) => words.has(t))) continue;
    if (toks.length > bestSize) { best = n; bestSize = toks.length; tied = false; }
    else if (toks.length === bestSize) tied = true;
  }
  return best && !tied ? best : null;
}

/** Season code for a date, e.g. "2627" for the 2026-27 season (runs from July). */
export function seasonCode(date = new Date()) {
  const start = date.getUTCMonth() + 1 >= 7 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  const two = (y) => String(y % 100).padStart(2, '0');
  return two(start) + two(start + 1);
}

function previousSeasonCode(code) {
  const a = Number(code.slice(0, 2));
  const two = (y) => String((y + 100) % 100).padStart(2, '0');
  return two(a - 1) + two(a);
}

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** Pulls the 1X2 / Over-Under odds this site uses out of one CSV row. */
function oddsOf(g) {
  const triple = (h, d, a) => {
    const t = { home: num(g(h)), draw: num(g(d)), away: num(g(a)) };
    return t.home && t.draw && t.away ? t : null;
  };
  const over = num(g('Avg>2.5'));
  const under = num(g('Avg<2.5'));
  return {
    bwin: triple('BWH', 'BWD', 'BWA'),
    market: triple('AvgH', 'AvgD', 'AvgA'),
    over25: over && under ? { over, under } : null,
  };
}

/**
 * Minimal CSV parser for this site's files: plain comma-separated, no quoted
 * fields (checked across every league and both seasons), a BOM on the header.
 * Columns are looked up by name — their positions differ by league and season.
 */
function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const index = new Map(header.map((h, i) => [h, i]));
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return (key) => (index.has(key) ? cells[index.get(key)] ?? '' : '');
  });
}

/** "13/10/2026" + "19:45" (UK local time) → Date. Close enough for ordering and a same-day match. */
function parseDate(d, t) {
  const [dd, mm, yy] = d.split('/');
  const year = yy.length === 2 ? `20${yy}` : yy;
  return new Date(`${year}-${mm}-${dd}T${t || '15:00'}:00Z`);
}

async function fetchCsv(path) {
  const res = await fetch(BASE + path, { redirect: 'follow' });
  if (!res.ok) throw new Error(`football-data.co.uk ${path} -> HTTP ${res.status}`);
  return parseCsv(await res.text());
}

/**
 * Every finished match of a league's current and previous season, oldest
 * first. A missing previous-season file (e.g. a league added mid-history)
 * is tolerated; a missing current one isn't.
 */
export async function fetchLeagueHistory(code, now = new Date()) {
  const current = seasonCode(now);
  const seasons = [previousSeasonCode(current), current];
  const rows = [];
  for (const s of seasons) {
    let parsed;
    try {
      parsed = await fetchCsv(`/mmz4281/${s}/${code}.csv`);
    } catch (err) {
      if (s === current) throw err;
      continue;
    }
    for (const g of parsed) {
      const hg = num(g('FTHG'));
      const ag = num(g('FTAG'));
      if (hg == null || ag == null || !g('HomeTeam')) continue;
      rows.push({
        date: parseDate(g('Date'), g('Time')),
        home: g('HomeTeam'),
        away: g('AwayTeam'),
        hg,
        ag,
        hxg: num(g('HxG')),
        axg: num(g('AxG')),
        odds: oddsOf(g),
      });
    }
  }
  return rows.sort((a, b) => a.date - b.date);
}

/** Upcoming matches with pre-match odds, keyed by division code. */
export async function fetchUpcomingOdds() {
  const parsed = await fetchCsv('/fixtures.csv');
  const byCode = new Map();
  for (const g of parsed) {
    if (!g('HomeTeam')) continue;
    const code = g('Div');
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({ date: parseDate(g('Date'), g('Time')), home: g('HomeTeam'), away: g('AwayTeam'), odds: oddsOf(g) });
  }
  return byCode;
}

/**
 * A team's last `keep` matches strictly before `before`, in the shape
 * summarizeTeamForm expects — real goals for the W/D/L badges, xG (where the
 * source has it) for strength.
 */
export function teamMatchesBefore(history, team, before, keep = 38) {
  const out = [];
  for (const m of history) {
    if (m.date >= before) break;
    if (m.home !== team && m.away !== team) continue;
    const isHome = m.home === team;
    out.push({
      date: m.date.toISOString(),
      venue: isHome ? 'home' : 'away',
      gf: isHome ? m.hg : m.ag,
      ga: isHome ? m.ag : m.hg,
      xgf: isHome ? m.hxg : m.axg,
      xga: isHome ? m.axg : m.hxg,
    });
  }
  return out.slice(-keep);
}

/** Same match in the history (or upcoming list): same pair of teams, kickoff within a day. */
export function findMatch(rows, home, away, date) {
  const t = new Date(date).getTime();
  return rows.find((m) => m.home === home && m.away === away && Math.abs(m.date.getTime() - t) < 36 * 3_600_000) || null;
}
