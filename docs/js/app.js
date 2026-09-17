import { pct, kickoff, relativeAgo } from './format.js';

const ALERT_THRESHOLD = 0.5;
const ALERT_WINDOW_HOURS = 48;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const state = {
  fixtures: [],
  league: '',
  hideLowSample: false,
  search: '',
  notify: false,
};

const els = {
  metaRow: document.getElementById('metaRow'),
  hero: document.getElementById('hero'),
  heroCards: document.getElementById('heroCards'),
  leagueFilter: document.getElementById('leagueFilter'),
  hideLowSample: document.getElementById('hideLowSample'),
  teamSearch: document.getElementById('teamSearch'),
  rows: document.getElementById('rows'),
  emptyState: document.getElementById('emptyState'),
  notifyBtn: document.getElementById('notifyBtn'),
  installHint: document.getElementById('installHint'),
  installHow: document.getElementById('installHow'),
  installHintClose: document.getElementById('installHintClose'),
};

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function formBadges(letters, title) {
  if (!letters.length) return '<span class="form-none">—</span>';
  const spans = letters.map((l) => `<span class="form-badge form-${l.toLowerCase()}">${l}</span>`).join('');
  return `<span class="form-badges" title="${title}">${spans}</span>`;
}

function meter(value, cls = '') {
  const w = value == null ? 0 : Math.round(value * 100);
  return `
    <div class="meter">
      <div class="meter-track"><div class="meter-fill ${cls}" style="width:${w}%"></div></div>
      <span class="meter-value">${pct(value)}</span>
    </div>`;
}

function renderMeta(payload) {
  const isLive = payload.source !== 'mock';
  const sourceLabel = isLive ? `Live · ${payload.source.toUpperCase()}` : 'Demo data';
  els.metaRow.innerHTML = `
    <span class="badge ${isLive ? 'source-live' : 'source-mock'}">${sourceLabel}</span>
    <span>Refreshed ${relativeAgo(payload.generatedAt)}</span>
  `;
}

function renderHero(fixtures) {
  const top = fixtures.slice(0, 3);
  if (!top.length) { els.hero.hidden = true; return; }
  els.hero.hidden = false;
  els.heroCards.innerHTML = top.map((f, i) => `
    <div class="hero-card">
      <div class="hero-card-head">
        <span class="hero-rank">#${i + 1}</span>
        <span class="hero-league">${f.league}</span>
      </div>
      <div class="hero-match"><span class="home">${f.home.name}</span><span class="vs">vs</span>${f.away.name}</div>
      <div class="hero-figures">
        <div class="figure figure-combined"><div class="figure-value">${pct(f.score.combined)}</div><div class="figure-label">Away win + BTTS</div></div>
        <div class="figure"><div class="figure-value">${pct(f.score.awayWinLikelihood)}</div><div class="figure-label">Away win</div></div>
        <div class="figure"><div class="figure-value">${pct(f.score.bttsLikelihood)}</div><div class="figure-label">BTTS</div></div>
      </div>
      <div class="hero-kickoff">${kickoff(f.date)}</div>
    </div>
  `).join('');
}

function populateLeagues(fixtures) {
  const leagues = [...new Set(fixtures.map((f) => f.league))].sort();
  els.leagueFilter.innerHTML = '<option value="">All leagues</option>' +
    leagues.map((l) => `<option value="${l}">${l}</option>`).join('');
}

function applyFilters() {
  return state.fixtures.filter((f) => {
    if (state.league && f.league !== state.league) return false;
    if (state.hideLowSample && f.score.confidence === 'low') return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      if (!f.home.name.toLowerCase().includes(q) && !f.away.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const filtered = applyFilters();
  renderHero(filtered);

  els.emptyState.hidden = filtered.length > 0;
  els.rows.innerHTML = filtered.map((f) => `
    <tr>
      <td class="kickoff" data-label="Kickoff">${kickoff(f.date)}</td>
      <td class="league" data-label="League">${f.league}</td>
      <td class="fixture" data-label="Fixture">
        <span class="home">${f.home.name}</span><span class="vs">vs</span>${f.away.name}
        ${f.score.confidence === 'low' ? '<span class="confidence-low" title="Fewer than 5 recent matches on record for one side">low sample</span>' : ''}
        <div class="form-row">
          <span class="form-label">Home</span>
          ${formBadges(f.stats.home.homeForm, `${f.home.name}'s last home matches, oldest to newest`)}
          <span class="form-label">Away</span>
          ${formBadges(f.stats.away.awayForm, `${f.away.name}'s last away matches, oldest to newest`)}
        </div>
      </td>
      <td data-label="Away win">${meter(f.score.awayWinLikelihood)}</td>
      <td data-label="BTTS">${meter(f.score.bttsLikelihood)}</td>
      <td data-label="Combined">${meter(f.score.combined, 'combined')}</td>
    </tr>
  `).join('');
}

/* ------------------------------- PWA + alerts ------------------------------ */

const notifyPermission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/** True once the page is running as an installed app (iOS requires this). */
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function showInstallHint(message) {
  els.installHow.textContent = message
    || (isIos()
      ? 'In Safari: Share → Add to Home Screen, then open it from there and tap Alerts again.'
      : 'Install this app from your browser menu, then tap Alerts again.');
  els.installHint.hidden = false;
}

/** Notifications go through the service worker: iOS has no Notification ctor. */
async function notify(title, body, tag) {
  if (!state.notify || notifyPermission() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg?.showNotification) {
      await reg.showNotification(title, {
        body, tag: tag || 'btts-tracker', icon: './icons/icon-192.png', badge: './icons/icon-192.png',
      });
    }
  } catch { /* notification is best-effort */ }
}

function syncNotifyButton() {
  const on = state.notify && notifyPermission() === 'granted';
  els.notifyBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  els.notifyBtn.querySelector('span[aria-hidden]').textContent = on ? '●' : '○';
}

async function enableNotifications() {
  if (notifyPermission() === 'unsupported') {
    showInstallHint('This browser does not support notifications.');
    return;
  }
  // On iOS, asking from a Safari tab is denied outright; it only works once the
  // app has been added to the Home Screen.
  if (isIos() && !isStandalone()) {
    showInstallHint();
    return;
  }
  let perm = notifyPermission();
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; }
  }
  if (perm !== 'granted') {
    showInstallHint(perm === 'denied'
      ? 'Notifications are blocked for this site — enable them in your browser settings.'
      : undefined);
    state.notify = false;
  } else {
    state.notify = true;
    notify('Alerts on', `You'll be told when a fixture clears ${pct(ALERT_THRESHOLD)} away win + BTTS.`);
    maybeNotifyFixtures(state.fixtures);
  }
  writeStore('btts-notify', state.notify);
  syncNotifyButton();
}

async function toggleNotifications() {
  if (state.notify) {
    state.notify = false;
    writeStore('btts-notify', false);
    syncNotifyButton();
    return;
  }
  await enableNotifications();
}

/**
 * Fire an alert for a fixture that just cleared the threshold, once per
 * fixture. Only "ok" confidence fixtures count — a low-sample fixture
 * hitting 100% from one lucky match isn't worth an interruption.
 */
function maybeNotifyFixtures(fixtures) {
  if (!state.notify) return;
  const notifiedIds = new Set(readStore('btts-notified-ids', []));
  const now = Date.now();
  const windowMs = ALERT_WINDOW_HOURS * 3600 * 1000;
  let changed = false;

  for (const f of fixtures) {
    if (f.score.confidence !== 'ok') continue;
    if (f.score.combined < ALERT_THRESHOLD) continue;
    const kickoffMs = new Date(f.date).getTime();
    if (kickoffMs < now || kickoffMs - now > windowMs) continue;
    if (notifiedIds.has(f.id)) continue;

    notifiedIds.add(f.id);
    changed = true;
    notify(
      `${f.home.name} vs ${f.away.name}`,
      `${pct(f.score.combined)} away win + BTTS · ${f.league} · ${kickoff(f.date)}`,
      `fixture-${f.id}`,
    );
  }

  if (changed) writeStore('btts-notified-ids', [...notifiedIds].slice(-300));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
}

/* ---------------------------------------------------------------------- */

async function refreshData() {
  const res = await fetch('./data/fixtures.json', { cache: 'no-store' });
  const payload = await res.json();
  state.fixtures = payload.fixtures;
  renderMeta(payload);
  populateLeagues(state.fixtures);
  render();
  maybeNotifyFixtures(state.fixtures);
}

async function main() {
  registerServiceWorker();
  state.notify = readStore('btts-notify', false) && notifyPermission() === 'granted';
  syncNotifyButton();

  await refreshData();

  els.leagueFilter.addEventListener('change', (e) => { state.league = e.target.value; render(); });
  els.hideLowSample.addEventListener('change', (e) => { state.hideLowSample = e.target.checked; render(); });
  els.teamSearch.addEventListener('input', (e) => { state.search = e.target.value; render(); });
  els.notifyBtn.addEventListener('click', toggleNotifications);
  els.installHintClose.addEventListener('click', () => { els.installHint.hidden = true; });

  // Alerts only fire while the page is open — refetch periodically (and
  // immediately on return to the tab) so a long-open tab still catches new
  // fixtures crossing the threshold between scheduled refreshes. Once we
  // have a first successful load, a later refresh failing shouldn't wipe
  // the page — just log it and keep showing the last good data.
  const backgroundRefresh = () => refreshData().catch((err) => console.error(err));
  setInterval(() => { if (document.visibilityState === 'visible') backgroundRefresh(); }, REFRESH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') backgroundRefresh();
  });
}

main().catch((err) => {
  console.error(err);
  els.rows.innerHTML = '';
  els.emptyState.hidden = false;
  els.emptyState.textContent = 'Could not load fixture data.';
});
