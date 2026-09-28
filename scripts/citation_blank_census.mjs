// D160 measurement three: population identical to probe 1 (which printed 200), asking two narrower questions —
// how many cited lines are blank, and how many anchors sit within +-3 lines of the citation.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const src = readFileSync('scripts/check_ledger_citations.mjs', 'utf8').replace(/\r\n/g, '\n').split('\n');
const hit = src.filter((l) => l.includes('matchAll(') && l.includes('(['));
if (hit.length !== 1) throw new Error('grammar moved: ' + hit.length);
const body = hit[0].match(/matchAll\((\/.*\/g)\)/)[1];
const GRAMMAR = new RegExp(body.slice(1, -2), 'g');
const anchor = /`([A-Za-z_$][A-Za-z0-9_$().:+\/ -]{2,40}?)`/g;
const norm = (s) => s.replace(/[():. +]/g, '').toLowerCase();
let total = 0, blank = 0, anchored = 0, exact = 0, win3 = 0, winFile = 0;
const blanks = [];
for (const doc of ['docs/DECISIONS.md', 'docs/STATUS.md']) {
  const text = readFileSync(doc, 'utf8').replace(/\r\n/g, '\n').split('\n');
  text.forEach((line, i) => {
    for (const m of line.matchAll(GRAMMAR)) {
      const name = m[1], num = Number(m[2]);
      if (!(/\.[A-Za-z0-9]{1,6}$/.test(name) || name.startsWith('.'))) continue;
      const abs = [join('scripts', name), join('data/seed', name), join('services/platform/src/main/java/com/nexus', name), name]
        .find((p) => existsSync(p));
      if (!abs) continue;
      const t = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
      const target = t[num - 1];
      if (target === undefined) continue;
      total += 1;
      if (!target.trim()) { blank += 1; if (blanks.length < 10) blanks.push(`${doc}:${i + 1} -> ${name}:${num}`); continue; }
      const sentence = (text[i - 1] || '') + ' ' + line;
      const cands = [...sentence.matchAll(anchor)].map((a) => a[1]).filter((a) => /[A-Za-z]{3}/.test(a) && !a.includes('/') && !a.endsWith(':') && !/:\d+$/.test(a));
      if (!cands.length) continue;
      anchored += 1;
      const on = (arr) => arr.some((x) => x !== undefined && cands.some((c) => norm(x).includes(norm(c))));
      if (on([target])) exact += 1;
      if (on(t.slice(Math.max(0, num - 4), num + 3))) win3 += 1;
      if (on(t)) winFile += 1;
    }
  });
}
console.log(`grammar ${body.length} chars · resolvable citations ${total} · blank cited line ${blank} · anchored ${anchored}`);
console.log(`anchor exact line ${exact} · within +-3 ${win3} · anywhere in file ${winFile} (of ${anchored})`);
for (const b of blanks) console.log('  BLANK ' + b);
