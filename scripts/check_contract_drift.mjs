#!/usr/bin/env node
/**
 * NEXUS contract-drift checker.
 *
 * Every route documented in docs/API_CONTRACT.md must exist in some implementation, and every route an
 * implementation advertises must be documented. CI should fail on drift (§156): a frontend calling a path
 * nobody serves, or a service shipping an undocumented endpoint, are both product bugs.
 *
 *   node scripts/check_contract_drift.mjs            # exit 1 when a documented route has no server
 *   node scripts/check_contract_drift.mjs --report   # report only, always exit 0
 *
 * Two gap classes are reported. MISSING = no source at all names the path. CLIENT-ONLY = the SDK or the UI
 * calls it but neither service answers; that is the more dangerous one because it looks finished.
 *
 * The two sides are matched differently, on purpose. A client names a route by its whole path string, so a
 * substring search is the right question. A handler declares one in pieces — `@RequestMapping("/api/v1/me")`
 * on the class, `@GetMapping("/favorites")` on the method — so the server side searches path literals and
 * pairs of them. What it may *not* do is match the last word alone: `/api/v1/merchant/reservations` and
 * `PATCH /api/v1/reservations/{id}` share that word, one is implemented and the other is not, and a checker
 * that cannot tell them apart reports a documented route as served and the gap disappears (§156).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTRACT = path.join(ROOT, 'docs', 'API_CONTRACT.md');
const SOURCES = [
  ['platform', path.join(ROOT, 'services', 'platform', 'src')],
  ['ai', path.join(ROOT, 'apps', 'ai')],
  ['web', path.join(ROOT, 'apps', 'web', 'app')],
  ['web-lib', path.join(ROOT, 'apps', 'web', 'src')],
  ['sdk', path.join(ROOT, 'packages', 'sdk', 'src')],
];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'target', '__pycache__', '.venv', 'out', 'report', '.artifacts']);

const reportOnly = process.argv.includes('--report');

/** Collect the route templates mentioned in the contract document. */
function documentedRoutes() {
  const md = readFileSync(CONTRACT, 'utf8');
  const routes = new Set();
  // Cell contents such as `GET /api/v1/admin/{users|merchants|…}` or `/api/v1/me/preferences[/{id}]`:
  // take the path out of the span, drop the method, collapse an alternation template to one placeholder.
  for (const m of md.matchAll(/`([^`]*)`/g)) {
    const p = m[1].trim().replace(/^(?:GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\s+/, '').split(/\s+/)[0];
    if (!/^\/(?:api\/v1|ai\/v1|well-known|mcp)\b/.test(p)) continue;
    routes.add(p.replace(/[.,;]$/, '').replace(/\{[^}]*\|[^}]*\}/g, '{x}').replace(/\?.*$/, ''));
  }
  // combined rows such as "`GET/PATCH/DELETE | /api/v1/me/preferences[/{id}]`"
  for (const m of md.matchAll(/(GET|POST|PATCH|PUT|DELETE)[ |/]+`?(\/(?:api\/v1|ai\/v1)[^\s`|,]+)/g)) routes.add(m[2].replace(/\?.*$/, ''));
  // The method-prefix scan stops at the first "|", so it truncates alternation templates such as
  // "/api/v1/admin/{users|merchants}". The backtick scan already captured those whole; drop the stubs.
  return [...routes]
    .filter((r) => r.length > 8 && (r.match(/\{/g) || []).length === (r.match(/\}/g) || []).length)
    .map((raw) => ({ raw, matcher: toMatcher(raw) }))
    .sort((a, b) => a.raw.localeCompare(b.raw));
}

/**
 * The web BFF surface (contract §0.1, `/api/nexus/**`). Deliberately kept out of `documentedRoutes()`:
 * those paths are proxies, so searching the services for them would produce a false CLIENT-ONLY row
 * for every route the BFF forwards. They exist only to answer the reverse question — is this code
 * literal something the contract names?
 */
function documentedProxies() {
  const md = readFileSync(CONTRACT, 'utf8');
  const paths = new Set();
  for (const m of md.matchAll(/`([^`]*)`/g)) {
    const p = m[1].trim().replace(/^(?:GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\s+/, '').split(/\s+/)[0];
    if (p.startsWith('/api/nexus/')) paths.add(p.replace(/[.,;]$/, ''));
  }
  return [...paths].map((raw) => {
    // `**` is a mount, not a route: `/api/nexus/platform/**` stands for every path under it. `toMatcher`
    // only understands the single-`*` form, so normalise before handing it over.
    const asRoute = raw.replace(/\*\*$/, '*');
    return { raw, matcher: toMatcher(asRoute) };
  });
}

/** `/api/v1/merchants/{id_or_slug}/reviews[/{id}]` -> /api/v1/merchants/[^/]+/reviews(?:/[^/]+)? */
function toMatcher(raw) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segments = raw.split('/').filter((s) => s.length > 0);
  let out = '';
  for (const seg of segments) {
    const optional = /^\[(.+)\]$/.exec(seg);
    const body = optional ? optional[1] : seg;
    let piece;
    if (body.includes('{')) piece = '[^/]+';
    else if (body === '*') piece = '.*';
    else piece = esc(body);
    out += optional ? `(?:/${piece})?` : `/${piece}`;
  }
  return new RegExp(`^${out}$`);
}

/** Flatten a path fragment out of a route template so a text search can find it in code. */
function signature(raw) {
  const parts = raw
    .replace(/^\/(api\/v1|ai\/v1)\//, '')
    .split('/')
    .filter((s) => s && !s.startsWith('{') && !s.includes('[') && !s.includes('|'))
    .filter((s) => !/^(id|slug|merchant|user|provider|job_id|case_id|member_id|order_id|item_id|conversation|me|v1|api|ai)$/.test(s));
  return parts[parts.length - 1] ?? '';
}

/**
 * The last two **literal** path segments, as a matcher a server source can be tested against.
 *
 * `signature()` answers the client's question ("does anything call this path?") by name alone, which is far
 * too weak for the server's: `GET /api/v1/merchant/reservations` and `PATCH /api/v1/reservations/{id}` share
 * the trailing word `reservations`, and the second one *is* implemented — so a one-segment search reported
 * the first as served by a handler that never answers it. A documented route counted as served is the exact
 * false pass this script exists to prevent, so a server hit must carry the qualifier the path itself carries.
 *
 * Placeholders are positionally matched (`{slug}`, `{id}`, `{x}` are the same shape to Spring), and a
 * handler that splits the path across `@RequestMapping` + `@GetMapping` is reassembled by
 * {@link literalCandidates}.
 */
function serverSignature(raw) {
  const segs = raw.split('/').filter(Boolean).slice(-2);
  if (segs.length === 0) return null;
  const body = segs
    .map((seg) => (seg.startsWith('{') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`(?:^|/)${body}$`);
}

/** Path-shaped quoted literals in a file — `/api/v1/me`, `/favorites`, `/merchants/{slug}`. */
function pathLiterals(text) {
  return [...text.matchAll(/["'`](\/[^"'`\n]{1,160})["'`]/g)].map((m) => m[1]);
}

/**
 * Does this file declare the route? Either one literal carries the whole tail, or two path literals split it the
 * way Spring does: `@RequestMapping("/api/v1/me")` on the class and `@GetMapping("/favorites")` on the method.
 * The pair search is not positional — annotations sit far apart in a controller — but both halves must be
 * path literals, which keeps prose strings out of it.
 */
function declares(paths, serverSig) {
  for (const a of paths) {
    if (serverSig.test(a)) return true;
    for (const b of paths) if (a !== b && serverSig.test(a + b)) return true;
  }
  return false;
}

function sourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(java|kt|py|ts|tsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const corpus = [];
for (const [name, dir] of SOURCES) {
  for (const f of sourceFiles(dir)) {
    corpus.push({ owner: name, file: path.relative(ROOT, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') });
  }
}

const SERVER = new Set(['platform', 'ai']);
for (const entry of corpus) {
  if (SERVER.has(entry.owner)) entry.paths = pathLiterals(entry.text);
}

const routes = documentedRoutes();
const missing = [];
const clientOnly = [];
const found = [];
const wildcards = [];
for (const route of routes) {
  const sig = signature(route.raw);
  const serverSig = serverSignature(route.raw);
  if (!sig || !serverSig) continue;
  // `/api/v1/me/*` and `/api/v1/ai/**` are prose shorthand for a family the same section lists one row at a
  // time. Matching them as endpoints asks a source file to contain a literal asterisk, and whatever it does
  // match is an accident — so they are reported separately, never counted either way.
  if (/\/\*\*?$/.test(route.raw)) {
    wildcards.push(route.raw);
    continue;
  }
  const hits = corpus.filter((c) => (SERVER.has(c.owner) ? declares(c.paths, serverSig) : c.text.includes(sig)));
  const owners = [...new Set(hits.map((h) => h.owner))];
  if (!owners.length) missing.push({ route: route.raw, sig: `${sig} / ${serverSig.source}` });
  // A path only the SDK or the UI names is a call nobody answers: exactly the drift that ships a broken button.
  else if (!owners.some((o) => SERVER.has(o))) clientOnly.push({ route: route.raw, owners });
  else found.push({ route: route.raw, owners });
}

console.log(`contract routes parsed: ${routes.length}`);
console.log(`served by platform/ai: ${found.length}`);
if (wildcards.length) console.log(`wildcard shorthand, not treated as endpoints: ${wildcards.join(', ')}`);
if (clientOnly.length) {
  console.log(`\nCLIENT-ONLY — documented and referenced by sdk/web, but no service implements it (${clientOnly.length}):`);
  for (const c of clientOnly) console.log(`  - ${c.route}  [${c.owners.join(', ')}]`);
}
if (missing.length) {
  console.log(`\nMISSING — documented but not found in any implementation (${missing.length}):`);
  for (const m of missing) console.log(`  - ${m.route}  (searched for segment "${m.sig}")`);
}
const owners = SOURCES.map(([n, d]) => `${n}:${existsSync(d) ? sourceFiles(d).length : 0}`);
console.log(`\nsource corpus: ${corpus.length} files (${owners.join(', ')})`);

// Reverse direction: a path literal in code that the contract never mentions. This is the same bug seen from
// the other side — the SDK or UI is calling something nobody documented (and usually nobody serves).
const documented = new Set(routes.map((r) => r.raw));
const literalPaths = new Map();
for (const c of corpus) {
  for (const m of c.text.matchAll(/["'`]((?:\/api\/v1|\/ai\/v1|\/api\/nexus)\/[A-Za-z0-9_/{}.-]*)["'`]/g)) {
    const p = m[1].replace(/\$\{[^}]*\}/g, '{}').replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
    if (!literalPaths.has(p)) literalPaths.set(p, new Set());
    literalPaths.get(p).add(c.owner);
  }
}
const knownMatchers = routes.map((r) => ({ matcher: toMatcher(r.raw.replace(/\{[^}]*\}/g, '{}')), raw: r.raw }));
const proxyMatchers = documentedProxies().map((p) => ({ matcher: p.matcher, raw: p.raw }));
const norm = (p) => p.replace(/\{[^}]*\}/g, '{}');
// A literal that is a documented route, or a strict prefix of one (a class-level @RequestMapping base
// path such as "/api/v1/merchant/ai-agent" in front of "/ai-agent/config"), is not drift. An
// *extension* of a documented route ("/x/{id}/reindex") is drift — that is an endpoint nobody specified.
const isDocumented = (p) => {
  const n = norm(p);
  if (documented.has(p)) return true;
  // The BFF's own §0.1 surface, including its `/**` proxy mounts.
  if (n.startsWith('/api/nexus/')) return proxyMatchers.some((k) => k.matcher.test(n));
  if (knownMatchers.some((k) => k.matcher.test(n))) return true;
  const segs = n.split('/');
  return routes.some((r) => {
    const rs = norm(r.raw).split('/');
    if (segs.length >= rs.length) return false;
    return segs.every((s, i) => s === rs[i] || rs[i] === '{}');
  });
};
const undocumented = [...literalPaths.entries()]
  .filter(([p]) => p.split('/').length > 3 && !p.includes('...') && !isDocumented(p))
  .sort(([a], [b]) => a.localeCompare(b));
if (undocumented.length) {
  console.log(`\nUNDOCUMENTED — code references a path the contract never defines (${undocumented.length}):`);
  for (const [p, o] of undocumented) console.log(`  - ${p}  [${[...o].join(', ')}]`);
}
if (!reportOnly && (missing.length || clientOnly.length || undocumented.length)) process.exit(1);
