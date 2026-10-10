#!/usr/bin/env node
/**
 * NEXUS live-payload conformance checker.
 *
 * `packages/types` proves its schemas, enums and fixtures agree with each other, and
 * `scripts/check_contract_drift.mjs` proves the routes on both sides are documented. Neither of them
 * has ever looked at a byte a running service actually sent — so "the platform conforms to
 * API_CONTRACT §1/§2" was, until now, a claim about TypeScript files rather than about the service.
 *
 * This script closes that gap with the same validator the contract package tests itself with:
 *
 *   .venv-free:  node scripts/verify_payload_conformance.mjs [--report] [--json]
 *
 * It reads the *published* artefacts (`packages/types/dist/schemas/` + `manifest.json`, so an
 * uncommitted schema edit cannot quietly change what is checked), issues a small set of documented
 * reads against the local services, and validates every object that has a published schema:
 *
 *   - each `EntityCard` in `GET /api/v1/merchants` (the §4 directory) and `POST /ai/v1/search` (§7)
 *   - every `Fact` inside those cards (via the `$ref` in `entity_card.json`)
 *   - every non-2xx body, from three deliberately wrong calls, against `error_envelope.json` (§1)
 *
 * A service that is not listening is reported as **not verified** and does not fail the run: silence
 * about an absent server must not be laundered into a pass, and an offline laptop must not look like
 * a broken contract. Exit code is 1 only for a payload that actually violates a published schema.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SchemaStore, validate } from '../packages/types/scripts/json-schema-mini.mjs';
import { buildRules } from '../packages/types/scripts/rules.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'packages', 'types', 'dist', 'schemas');
const PLATFORM = (process.env.PLATFORM_API_BASE_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '');
const AI = (process.env.AI_API_BASE_URL ?? 'http://127.0.0.1:8010').replace(/\/$/, '');
const TENANT = process.env.NEXUS_TENANT ?? 'hong-kong';
const HEADERS = { 'content-type': 'application/json', 'x-tenant': TENANT };

const args = new Set(process.argv.slice(2));
const reportOnly = args.has('--report');
const asJson = args.has('--json');

/** @returns {Promise<{ok:boolean,status:number,body:any,transport:string}>} */
async function call(base, method, p, body) {
  let response;
  try {
    response = await fetch(base + p, {
      method,
      headers: HEADERS,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const code = error?.cause?.code ?? error?.name ?? 'error';
    return { ok: false, status: 0, body: null, transport: `unreachable (${code})` };
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: response.status, body: null, transport: 'non-json body' };
  }
  return { ok: response.ok, status: response.status, body: parsed, transport: 'http' };
}

async function loadSchemas() {
  const store = new SchemaStore();
  const docs = {};
  const manifest = JSON.parse(await readFile(path.join(SCHEMA_DIR, 'manifest.json'), 'utf8'));
  for (const entry of manifest.schemas) {
    const doc = JSON.parse(await readFile(path.join(SCHEMA_DIR, entry.file), 'utf8'));
    docs[entry.name] = doc;
    store.add(doc, entry.file);
  }
  const onDisk = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  const declared = manifest.schemas.map((e) => e.file).sort();
  if (onDisk.join() !== declared.join()) {
    throw new Error(`manifest and dist/schemas disagree: ${onDisk.join()} vs ${declared.join()}`);
  }
  return { store, docs, manifest };
}

/**
 * The runtime registries `rules.mjs` needs (TTL table, confidence floors, budgets, enums), loaded
 * from the built `dist/` modules rather than re-derived here — otherwise this script would enforce
 * its own copy of the numbers and could drift from the contract it claims to verify.
 */
async function loadRuntime() {
  const dist = path.join(ROOT, 'packages', 'types', 'dist');
  const runtime = {};
  for (const name of ['enums', 'fact', 'errors', 'tools']) {
    Object.assign(runtime, await import(pathToFileURL(path.join(dist, `${name}.js`)).href));
  }
  if (runtime.NEXUS_ENUMS === undefined) throw new Error('dist/enums.js exports no NEXUS_ENUMS — run `npm run build` in packages/types');
  return runtime;
}

const report = { probes: [], instances: 0, invalid: 0, ruleViolations: 0, skipped: [], unvalidated: [] };

function record(name, base, p, method, body) {
  report.probes.push({ name, target: `${base}${p}`, method, status: body?.status ?? 0, transport: body?.transport ?? 'http' });
}

/**
 * Validate `instance` against `schemaName` with the published schema **and** the cross-object rules
 * from `packages/types/scripts/rules.mjs` — the same 21 rules `validate_conformance.mjs` applies to
 * fixtures. Schema keywords alone cannot see that a rendered price has no backing fact, that a
 * sponsored card carries an organic rank, or that an `open` verdict cites a fact id the card never
 * shipped; those are the failures a live service is most likely to produce.
 *
 * @returns {Promise<string[]>} issue strings, empty when the payload conforms
 */
async function check(schemaName, instance, docs, store, where, rules) {
  report.instances += 1;
  const issues = [];
  const result = validate(docs[schemaName], instance, { store, maxIssues: 12 });
  if (!result.valid) {
    report.invalid += 1;
    issues.push(...result.issues.map((issue) => `${where}${issue.instancePath || ''}: ${issue.keyword} — ${issue.message}`));
  }
  const ctx = { schemaName, schemaProperties: docs[schemaName]?.properties ?? {} };
  const applicable = rules.filter((rule) => rule.schemas.includes(schemaName) || rule.schemas.includes('*'));
  const fired = [];
  for (const rule of applicable) {
    let messages;
    try {
      messages = await rule.check(instance, ctx);
    } catch (error) {
      messages = [`rule threw: ${error?.message ?? error}`];
    }
    if (messages?.length) fired.push(`${rule.id} — ${messages.join('; ')}`);
  }
  if (fired.length) {
    report.ruleViolations += 1;
    issues.push(...fired.map((message) => `${where}: ${message}`));
  }
  return issues;
}

async function main() {
  const { store, docs, manifest } = await loadSchemas();
  const rules = buildRules(await loadRuntime());
  const failures = [];
  const note = (schemaName, what) => report.unvalidated.push(`${schemaName}: ${what}`);

  /* ---- §1 error envelopes, from deliberately wrong calls ------------------------------- */
  const errorCases = [
    ['platform 404', PLATFORM, 'GET', '/api/v1/merchants/no-such-merchant-slug-xyz', undefined, 404],
    ['platform 422 sort', PLATFORM, 'GET', '/api/v1/merchants?sort=bogus', undefined, 422],
    ['ai 422 filters', AI, 'POST', '/ai/v1/search', { query: '', filters: { sort: 'distance' } }, 422],
  ];
  for (const [name, base, method, p, body, expectStatus] of errorCases) {
    const result = await call(base, method, p, body);
    record(name, base, p, method, result);
    if (result.transport !== 'http') {
      report.skipped.push(`${name} — service ${result.transport}`);
      continue;
    }
    if (result.status !== expectStatus) {
      failures.push(`${name}: expected ${expectStatus}, got ${result.status}`);
      continue;
    }
    failures.push(...(await check('error_envelope', result.body, docs, store, `${name} body`, rules)));
  }

  /* ---- §2 EntityCards from the two documented browse/search reads ---------------------- */
  const directory = await call(PLATFORM, 'GET', '/api/v1/merchants?sort=-rating&limit=5', undefined);
  record('platform directory', PLATFORM, '/api/v1/merchants?sort=-rating&limit=5', 'GET', directory);
  if (directory.transport !== 'http') report.skipped.push('platform directory — service unreachable');
  else if (!directory.ok || !Array.isArray(directory.body?.items)) {
    failures.push(`platform directory: HTTP ${directory.status} instead of a page`);
  } else {
    for (const [i, card] of directory.body.items.entries()) {
      failures.push(...(await check('entity_card', card, docs, store, `directory item ${i} (${card?.slug})`, rules)));
    }
    const first = directory.body.items[0];
    if (first?.slug) {
      const detail = await call(PLATFORM, 'GET', `/api/v1/merchants/${encodeURIComponent(first.slug)}`, undefined);
      record('platform merchant profile', PLATFORM, `/api/v1/merchants/${first.slug}`, 'GET', detail);
      if (!detail.ok) failures.push(`merchant profile ${first.slug}: HTTP ${detail.status}`);
      else note('merchant_profile', `GET /api/v1/merchants/{slug} has no published schema (${Object.keys(detail.body ?? {}).length} top-level keys unchecked)`);
    }
  }

  const searched = await call(AI, 'POST', '/ai/v1/search', { query: 'cafe', limit: 5 });
  record('ai search', AI, '/ai/v1/search', 'POST', searched);
  if (searched.transport !== 'http') report.skipped.push('ai search — service unreachable');
  else if (!searched.ok || !Array.isArray(searched.body?.items)) {
    failures.push(`ai search: HTTP ${searched.status} instead of a result set`);
  } else {
    for (const [i, card] of searched.body.items.entries()) {
      failures.push(...(await check('entity_card', card, docs, store, `search item ${i} (${card?.slug})`, rules)));
    }
    const facts = searched.body.items.flatMap((card) => card?.facts ?? []);
    for (const [i, fact] of facts.entries()) failures.push(...(await check('fact', fact, docs, store, `search fact ${i} (${fact?.attribute})`, rules)));
  }

  /* ---- the browse rail the web actually asks for --------------------------------------- */
  const railStyle = await call(AI, 'POST', '/ai/v1/search', { query: '', filters: { sort: 'distance' }, limit: 8 });
  if (railStyle.transport === 'http' && railStyle.ok) note('home rails', 'an empty query returns 0 items, so a query-less rail cannot be served by /ai/v1/search');

  if (!asJson) {
    console.log(`schemas: ${manifest.schemas.length} from dist (${manifest.draft}); rules: ${rules.length} cross-object`);
    for (const probe of report.probes) console.log(`  ${String(probe.status).padEnd(3)} ${probe.method.padEnd(5)} ${probe.target}`);
    for (const line of report.skipped) console.log(`  NOT VERIFIED  ${line}`);
    for (const line of report.unvalidated) console.log(`  NO SCHEMA     ${line}`);
    console.log(`payloads: ${report.instances} validated, ${report.invalid} rejected by schema keywords, ${report.ruleViolations} by cross-object rules`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} contract violation(s):`);
    for (const line of failures.slice(0, 40)) console.log(`  - ${line}`);
    if (failures.length > 40) console.log(`  … ${failures.length - 40} more`);
  } else if (report.skipped.length === 0) {
    console.log('payload conformance OK — live services answer within the published contract.');
  } else {
    console.log(`payload conformance: no violations found in what was reachable (${report.skipped.length} probe(s) not verified).`);
  }
  if (asJson) console.log(JSON.stringify({ ...report, failures }, null, 2));
  process.exit(reportOnly || !failures.length ? 0 : 1);
}

main().catch((error) => {
  console.error(`payload conformance crashed: ${error?.stack ?? error}`);
  process.exit(2);
});
