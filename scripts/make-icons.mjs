#!/usr/bin/env node
/**
 * Renders the app icons with headless Chromium (no image libraries needed).
 *
 * The mark is a shaded soccer-ball glyph — a central pentagon with five
 * outer patches and seam lines, lit from the upper-left with a radial
 * gradient and a soft ground shadow for a 3D-sphere look — full-bleed on a
 * mowed-grass-green background (an original rendering, not a copy of any
 * stock photo).
 *
 * Usage: node scripts/make-icons.mjs
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Not a project dependency (this is a one-off local tool, run once and the
// output committed) — resolved via NODE_PATH against a global Playwright
// install instead, e.g.: NODE_PATH=$(npm root -g) node scripts/make-icons.mjs
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/icons');
const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const GRASS_LIGHT = '#4cb84f';
const GRASS_DARK = '#1f7a2e';
const BALL_LIGHT = '#f9f9f6';
const BALL_SHADOW = '#b9b8ae';
const BALL_DARK = '#141412';
const PATCH_LIGHT = '#333330';

/** Regular pentagon vertices as an SVG points string. */
const pentagon = (cx, cy, r, rotationDeg) => {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a = (rotationDeg + i * 72) * (Math.PI / 180);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
};

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

/** @param {number} inset fraction of the canvas kept clear for mask cropping */
const svg = (size, inset) => {
  const pad = size * inset;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - pad;

  const centralR = R * 0.34;
  const patchR = R * 0.26;
  const patchDist = R * 0.72;
  const strokeW = R * 0.03;
  const shadowRy = R * 0.16;
  const shadowCy = cy + R * 0.9;

  let patches = '';
  let seams = '';
  for (let i = 0; i < 5; i++) {
    const angle = -90 + i * 72;
    const rad = angle * (Math.PI / 180);
    const vx = cx + centralR * Math.cos(rad);
    const vy = cy + centralR * Math.sin(rad);
    const px = cx + patchDist * Math.cos(rad);
    const py = cy + patchDist * Math.sin(rad);
    seams += `<line x1="${vx.toFixed(2)}" y1="${vy.toFixed(2)}" x2="${px.toFixed(2)}" y2="${py.toFixed(2)}" stroke="${BALL_DARK}" stroke-width="${strokeW.toFixed(2)}" stroke-linecap="round"/>`;
    patches += `<polygon points="${pentagon(px, py, patchR, angle + 180)}" fill="url(#patchGrad)"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <radialGradient id="grassGrad" cx="50%" cy="38%" r="75%">
        <stop offset="0%" stop-color="${GRASS_LIGHT}"/>
        <stop offset="100%" stop-color="${GRASS_DARK}"/>
      </radialGradient>
      <radialGradient id="sphereGrad" cx="34%" cy="28%" r="80%">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="55%" stop-color="${BALL_LIGHT}"/>
        <stop offset="100%" stop-color="${BALL_SHADOW}"/>
      </radialGradient>
      <radialGradient id="patchGrad" cx="35%" cy="30%" r="100%">
        <stop offset="0%" stop-color="${PATCH_LIGHT}"/>
        <stop offset="100%" stop-color="${BALL_DARK}"/>
      </radialGradient>
      <filter id="soften" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="${(R * 0.07).toFixed(2)}"/>
      </filter>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#grassGrad)"/>
    ${grassStripes(size)}
    <ellipse cx="${cx}" cy="${shadowCy.toFixed(2)}" rx="${(R * 0.76).toFixed(2)}" ry="${shadowRy.toFixed(2)}" fill="#000000" opacity="0.45" filter="url(#soften)"/>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#sphereGrad)" stroke="${BALL_DARK}" stroke-width="${strokeW.toFixed(2)}"/>
    ${seams}
    ${patches}
    <polygon points="${pentagon(cx, cy, centralR, -90)}" fill="url(#patchGrad)"/>
    <ellipse cx="${(cx - R * 0.34).toFixed(2)}" cy="${(cy - R * 0.4).toFixed(2)}" rx="${(R * 0.24).toFixed(2)}" ry="${(R * 0.15).toFixed(2)}" fill="#ffffff" opacity="0.45" filter="url(#soften)"/>
  </svg>`;
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
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;background:${GRASS_DARK}">${svg(t.size, t.inset)}</body>`,
    { waitUntil: 'load' });
  await page.screenshot({ path: `${OUT}/${t.file}`, omitBackground: false });
  await page.close();
  console.log(`  ${t.file}  ${t.size}x${t.size}`);
}
await browser.close();
console.log('icons written to docs/icons');
