import { describe, expect, it } from 'vitest';

import {
  costShare,
  degradedRate,
  dependencyStateOf,
  healthRollup,
  isDegradedRun,
  isAdminRole,
  moderationCounts,
  parseAdminRole,
  parseStatedRole,
  parseSystemHealth,
  resolvableCases,
  sumOf,
  topIntents,
  zeroResultRate,
  type AdminAgentRun,
  type AdminModerationCase,
} from './console-admin';

/**
 * Guards for the admin data plane's pure logic (§68/§70/§9). What these protect are the promises the
 * admin console makes: a role it cannot read is not an admin; a degraded rate with no runs is not
 * 0%; a health rollup that lists nothing is `unknown`, never `ok`; and the moderation counts are
 * case-shaped, so the overview cannot restate a review case as a "listing change".
 */

describe('admin identity (§68)', () => {
  it('accepts only the two platform roles', () => {
    expect(isAdminRole('platform_admin')).toBe(true);
    expect(isAdminRole('platform_ops')).toBe(true);
    expect(isAdminRole('merchant_admin')).toBe(false);
  });

  it('finds a role in the documented carriers and fails closed otherwise', () => {
    expect(parseAdminRole({ role: 'platform_admin' })).toBe('platform_admin');
    expect(parseAdminRole({ user: { roles: ['consumer', 'platform_ops'] } })).toBe('platform_ops');
    expect(parseAdminRole({ memberships: [{ role: 'owner' }] })).toBeNull();
    expect(parseAdminRole(null)).toBeNull();
  });

  it('reports the stated role for the permission copy without granting it', () => {
    expect(parseStatedRole({ role: 'merchant_manager' })).toBe('merchant_manager');
    expect(parseAdminRole({ role: 'merchant_manager' })).toBeNull();
  });
});

describe('degraded rate (§70/§105)', () => {
  function run(over: Partial<AdminAgentRun>): AdminAgentRun {
    return {
      id: 'r',
      agent: 'search',
      model: 'm',
      provider: 'p',
      status: 'succeeded',
      degraded: false,
      latency_ms: null,
      tokens: null,
      cost_usd: null,
      started_at: null,
      conversation_id: null,
      ...over,
    };
  }

  it('counts a fallback status as degraded', () => {
    expect(isDegradedRun({ status: 'fallback', degraded: false })).toBe(true);
    expect(isDegradedRun({ status: 'degraded', degraded: false })).toBe(true);
    expect(isDegradedRun({ status: 'succeeded', degraded: true })).toBe(true);
    expect(isDegradedRun({ status: 'succeeded', degraded: false })).toBe(false);
  });

  it('no runs means no rate — null, not 0%', () => {
    expect(degradedRate([])).toBeNull();
    expect(degradedRate([run({ degraded: true }), run({}), run({}), run({})])).toBe(0.25);
  });
});

describe('health rollup (§9/§155)', () => {
  it('worst state wins and an empty list is unknown, never ok', () => {
    expect(healthRollup([])).toBe('unknown');
    expect(healthRollup(['ok', 'degraded'])).toBe('degraded');
    expect(healthRollup(['ok', 'down', 'degraded'])).toBe('down');
    expect(healthRollup(['ok', 'ok'])).toBe('ok');
    expect(healthRollup(['ok', 'unknown'])).toBe('unknown');
  });

  it('maps the platform vocabulary, and leaves a configuration answer unknown', () => {
    expect(dependencyStateOf('up')).toBe('ok');
    expect(dependencyStateOf('redis')).toBe('ok');
    expect(dependencyStateOf('in_memory')).toBe('ok');
    expect(dependencyStateOf('down')).toBe('down');
    expect(dependencyStateOf('configured')).toBe('unknown');
    expect(dependencyStateOf('not_configured')).toBe('unknown');
  });

  it('reads the served dependency map and keeps each raw word verbatim', () => {
    const parsed = parseSystemHealth({
      status: 'ok',
      dependencies: {
        database: { state: 'up', latency_ms: 4 },
        key_value: { state: 'in_memory' },
        ai_service: { state: 'not_configured', probed: false },
      },
      schema_version: 'V12',
      profiles: ['test'],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.overall).toBe('ok');
    expect(parsed!.schema_version).toBe('V12');
    expect(parsed!.profiles).toEqual(['test']);
    expect(parsed!.dependencies.map((entry) => entry.raw_status)).toEqual(['up', 'in_memory', 'not_configured']);
  });

  it('a stated overall status wins when no dependency row could be classified', () => {
    const parsed = parseSystemHealth({ status: 'degraded', dependencies: {} });
    expect(parsed!.overall).toBe('degraded');
    expect(parsed!.dependencies).toEqual([]);
  });
});

describe('cost helpers (§9)', () => {
  it('a share of an unknown total is unknown', () => {
    expect(costShare(1, null)).toBeNull();
    expect(costShare(null, 10)).toBeNull();
    expect(costShare(0, 0)).toBeNull();
    expect(costShare(2, 8)).toBe(0.25);
  });

  it('sumOf ignores unknowns and returns null when none are known', () => {
    expect(sumOf([null, null])).toBeNull();
    expect(sumOf([1, null, 2])).toBe(3);
  });
});

describe('search analytics helpers (§9)', () => {
  it('a zero-result rate is computed only over queries that stated a count', () => {
    expect(zeroResultRate([])).toBeNull();
    expect(
      zeroResultRate([
        { query: 'a', intent: null, results: 0, at: null },
        { query: 'b', intent: null, results: 3, at: null },
        { query: 'c', intent: null, results: null, at: null },
      ]),
    ).toBe(0.5);
  });

  it('the intent histogram is stable and ignores queries with no stated intent', () => {
    const intents = topIntents([
      { query: 'a', intent: 'discover', results: 1, at: null },
      { query: 'b', intent: 'discover', results: 1, at: null },
      { query: 'c', intent: 'reserve', results: 1, at: null },
      { query: 'd', intent: null, results: 1, at: null },
    ]);
    expect(intents.map((entry) => entry.intent)).toEqual(['discover', 'reserve']);
    expect(intents[0]?.share).toBeCloseTo(0.667, 3);
  });
});

describe('moderation counts (§9/§127)', () => {
  function kase(over: Partial<AdminModerationCase>): AdminModerationCase {
    return {
      case_id: 'c',
      subject_type: 'review',
      subject_id: 's',
      reason: null,
      policy: null,
      auto_action: null,
      case_status: 'open',
      resolution: null,
      resolution_note: null,
      resolved_at: null,
      created_at: null,
      subject_known: true,
      subject: null,
      demo: true,
      ...over,
    };
  }

  it('counts cases by case-status and counts only open review cases as resolvable', () => {
    const cases = [
      kase({ case_id: 'a' }),
      kase({ case_id: 'b', case_status: 'resolved', resolution: 'published' }),
      kase({ case_id: 'c', subject_type: 'merchant' }),
    ];
    expect(moderationCounts(cases)).toEqual({ total: 3, open: 2, resolved: 1, resolvable: 1 });
    expect(resolvableCases(cases).map((entry) => entry.case_id)).toEqual(['a']);
  });
});
