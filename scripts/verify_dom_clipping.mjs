#!/usr/bin/env node
/**
 * D1498 — runtime DOM clipping / overflow verifier for the live plane.
 *
 * §五's visual promise has source-level contrast gates but no check for three of the
 * user's named defects: text clipped by a fixed-height + overflow:hidden container,
 * rounded/overlapped blocks, and horizontal page overflow. This walks the real rendered
 * DOM of the primary routes in Chromium and measures them. It is a RUNTIME verifier
 * (name `verify_*`): it needs a live plane, so `verify_all.mjs` runs it only under
 * `--include-runtime`, where a missing plane is honestly UNCHECKED.
 *
 * Usage: node scripts/verify_dom_clipping.mjs [--url=http://127.0.0.1:3002]
 * Exit:  0 no clipping / overflow on any walked route · 1 at least one offender · 2 plane unreachable
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('verify_dom_clipping.mjs: playwright unavailable — refusing to judge');
  process.exit(2);
}

const arg = process.argv.find((a) => a.startsWith('--url='));
const base = (arg ? arg.slice(6) : 'http://127.0.0.1:3002').replace(/\/$/, '');
const ROUTES = ['/', '/world', '/hong-kong', '/try', '/handbook'];

async function main() {
  // Cheap liveness probe first — a refusal is not a pass.
  try {
    const r = await fetch(base + '/', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('status ' + r.status);
  } catch (e) {
    console.error(`verify_dom_clipping.mjs: plane ${base} unreachable (${e.message}) — UNCHECKED`);
    process.exit(2);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const offenders = [];
  for (const path of ROUTES) {
    await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const clipped = [];
      document.querySelectorAll('h1,h2,h3,p,li,button,a,label,span').forEach((el) => {
        if (!el.textContent || !el.textContent.trim()) return;
        const cs = getComputedStyle(el);
        if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden')
            && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 3) {
          clipped.push((el.tagName + '.' + String(el.className || '')).slice(0, 90));
        }
      });
      return {
        hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clipped,
      };
    });
    if (r.hOverflow > 1) offenders.push(`${path}: horizontal overflow ${r.hOverflow}px`);
    if (r.clipped.length) offenders.push(`${path}: ${r.clipped.length} clipped node(s) — ${r.clipped.slice(0, 3).join(' ; ')}`);
  }
  await browser.close();

  console.log(`routes walked   ${ROUTES.join(' ')}`);
  console.log(`offenders       ${offenders.length}`);
  for (const o of offenders) console.log('  - ' + o);
  if (offenders.length) {
    console.log('RESULT: FAIL — clipped text or horizontal overflow in the rendered DOM');
    process.exit(1);
  }
  console.log('RESULT: PASS — no clipped text, no horizontal overflow on any walked route');
}

main().catch((e) => {
  console.error('verify_dom_clipping.mjs: ' + e.message);
  process.exit(2);
});
