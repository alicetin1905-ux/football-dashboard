#!/usr/bin/env node
/**
 * Renders the app icons with headless Chromium (no image libraries needed).
 *
 * The mark is the user-supplied soccer-ball artwork (scripts/assets/soccer-ball.png,
 * a transparent-background PNG) composited over a mowed-grass-green
 * background, with a soft ground shadow for grounding.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Not a project dependency (this is a one-off local tool, run once and the
// output committed) — resolved via NODE_PATH against a global Playwright
// install instead, e.g.: NODE_PATH=$(npm root -g) node scripts/make-icons.mjs
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(ROOT, '../docs/icons');
const BALL_SRC = resolve(ROOT, 'assets/soccer-ball.png');
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const GRASS_LIGHT = '#4cb84f';
const GRASS_DARK = '#1f7a2e';

/** Alternating mowed-lawn stripe bands covering the full canvas. */
const grassStripes = (size) => {
  const bandH = size / 8;
  let out = '';
  for (let y = 0, i = 0; y < size; y += bandH, i++) {
    if (i % 2 === 1) {
      out += `<rect x="0" y="${y.toFixed(2)}" width="${size}" height="${bandH.toFixed(2)}" fill="#000000" opacity="0.08"/>`;
    }
  }
  return out;
};

const ballDataUri = `data:image/png;base64,${(await readFile(BALL_SRC)).toString('base64')}`;

/** @param {number} inset fraction of the canvas kept clear for mask cropping */
const page = (size, inset) => {
  const pad = size * inset;
  const cx = size / 2;
  const diameter = size - pad * 2;
  const shadowRy = diameter * 0.08;
  const shadowCy = cx + diameter * 0.46;

  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <radialGradient id="grassGrad" cx="50%" cy="38%" r="75%">
        <stop offset="0%" stop-color="${GRASS_LIGHT}"/>
        <stop offset="100%" stop-color="${GRASS_DARK}"/>
      </radialGradient>
      <filter id="soften" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="${(diameter * 0.035).toFixed(2)}"/>
      </filter>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#grassGrad)"/>
    ${grassStripes(size)}
    <ellipse cx="${cx}" cy="${shadowCy.toFixed(2)}" rx="${(diameter * 0.38).toFixed(2)}" ry="${shadowRy.toFixed(2)}" fill="#000000" opacity="0.4" filter="url(#soften)"/>
  </svg>`;

  return `<body style="margin:0;background:${GRASS_DARK}">
    ${bg}
    <img src="${ballDataUri}" style="position:absolute;left:${pad}px;top:${pad}px;width:${diameter}px;height:${diameter}px;" />
  </body>`;
};

const TARGETS = [
  { file: 'icon-192.png', size: 192, inset: 0.16 },
  { file: 'icon-512.png', size: 512, inset: 0.16 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.24 },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.16 },
];

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
await mkdir(OUT, { recursive: true });
for (const t of TARGETS) {
  const tabPage = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  await tabPage.setContent(page(t.size, t.inset), { waitUntil: 'load' });
  await tabPage.screenshot({ path: `${OUT}/${t.file}`, omitBackground: false });
  await tabPage.close();
  console.log(`  ${t.file}  ${t.size}x${t.size}`);
}
await browser.close();
console.log('icons written to docs/icons');
