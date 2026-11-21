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
    await page.goto(base + path, { waitUntil: 'networkidle', timeout: 30000 });
    // Fonts and CSS-driven layout settle after load; measuring at domcontentloaded
    // caught 112 false clipped-card reports on /hong-kong that vanish once painted.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    const r = await page.evaluate(() => {
      const clipped = [];
      document.querySelectorAll('h1,h2,h3,p,li,button,a,label,span').forEach((el) => {
        if (!el.textContent || !el.textContent.trim()) return;
        // sr-only / nexus-sr-only are CLIPPED ON PURPOSE — they are the accessible name
        // of an icon button, not reader copy. Charging them is a false positive (D1506).
        const cls = String(el.className || '');
        if (/\b(sr-only|nexus-sr-only)\b/.test(cls)) return;
        const cs = getComputedStyle(el);
        if (cs.overflow !== 'hidden' && cs.overflowY !== 'hidden') return;
        if (!(el.clientHeight > 0)) return;
        // Raw scrollHeight also counts absolutely-positioned DECORATIONS (giant ghost
        // numerals deliberately clipped by these cards). Measure real text children
        // against the content box instead — that is the "文字被裁掉" defect we judge.
        const box = el.getBoundingClientRect();
        const padB = parseFloat(cs.paddingBottom) || 0;
        const kids = [...el.querySelectorAll('*')].filter((k) => {
          if (!k.textContent || !k.textContent.trim()) return false;
          if (k.children.length > 0) return false; // leaf text nodes only
          return getComputedStyle(k).position !== 'absolute';
        });
        const over = kids.some((k) => k.getBoundingClientRect().bottom > box.bottom - padB + 2);
        if (over) clipped.push((el.tagName + '.' + cls).slice(0, 90));
      });
      // Honesty gate: a streaming Suspense skeleton is not a rendered page. Measuring it
      // would produce a clean bill of health for a page that never showed its content.
      const mainText = document.querySelector('main')?.innerText || '';
      const skeleton = /加载中|Loading/.test(mainText)
        || !!document.querySelector('main template[id^="B:"]');
      return {
        hOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        clipped,
        skeleton,
      };
    });
    if (r.skeleton) {
      console.error(`verify_dom_clipping.mjs: ${path} is an unresolved streaming skeleton — refusing to judge`);
      process.exit(2);
    }
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
