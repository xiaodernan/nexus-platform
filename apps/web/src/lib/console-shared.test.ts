import { describe, expect, it } from 'vitest';

import {
  aiDraftState,
  analyticsEventSeries,
  analyticsFieldProvided,
  analyticsProvidedFields,
  campaignCounts,
  campaignIsTerminal,
  campaignPublishable,
  conversionRate,
  countByAiState,
  distributionShares,
  emptyAgentConfigDraft,
  emptyOfferingDraft,
  failedRead,
  freshnessOf,
  funnelRates,
  importJobStages,
  importJobTerminal,
  importProposalCounts,
  isHandoffAction,
  knowledgeDocumentIndexed,
  knowledgeSummary,
  listingDraftIsDirty,
  listingPatchBody,
  messageIsAiAuthored,
  moderationCaseResolvable,
  moderationCaseStatusOf,
  moderationDecisionOf,
  moderationDisplayStatus,
  nextReservationStates,
  offeringDraftBody,
  okRead,
  parseAdminAskAnswer,
  proposalIsLowConfidence,
  publishGateOpen,
  reservationCounts,
  reservationDayKey,
  reservationGuestLabel,
  reservationsOnDay,
  reviewEvidenceCoverage,
  searchDailySeries,
  searchFulfilmentShare,
  summarizeQueue,
  threadNeedsHuman,
  validateAgentConfigDraft,
  validateListingDraft,
  validateOfferingDraft,
  verificationStateOf,
  type AiProvenance,
  type ListingDraft,
  type MerchantCampaign,
  type MerchantReservation,
  type ReviewIntelligence,
  type ReviewQueueItem,
} from './console-shared';
import {
  DEMO_CONSOLE_EMPTY_INBOX,
  fixtureConversations,
  fixtureListingDraft,
  fixtureMerchantOverview,
  fixtureReviewQueue,
} from './console-fixtures';

/**
 * Guards for the console helper layer (§23/§27/§47). What these tests protect are the promises the
 * consoles make to an operator: a figure without a timestamp is `unknown`-fresh rather than
 * silently fresh; a derived rate never invents a denominator; the edit form's validation codes
 * match what the copy dictionary can render; and the review queue's "unreviewed AI" count is the
 * number a human actually owes attention.
 */

const NOW = new Date('2026-09-22T08:00:00Z');

function at(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}

describe('freshnessOf', () => {
  it('buckets by age against the payload timestamp', () => {
    expect(freshnessOf(at(2), NOW)).toBe('fresh');
    expect(freshnessOf(at(14), NOW)).toBe('fresh');
    expect(freshnessOf(at(60), NOW)).toBe('recent');
    expect(freshnessOf(at(60 * 23), NOW)).toBe('recent');
    expect(freshnessOf(at(60 * 30), NOW)).toBe('stale');
  });

  it('missing, malformed or future timestamps are unknown, never fresh', () => {
    expect(freshnessOf(null, NOW)).toBe('unknown');
    expect(freshnessOf('not-a-date', NOW)).toBe('unknown');
    expect(freshnessOf(at(-5), NOW)).toBe('unknown');
  });
});

describe('okRead / failedRead', () => {
  it('a live read carries its endpoint, timestamp and freshness', () => {
    const read = okRead({ data: 1, origin: 'live', source: 'GET /api/v1/x', asOf: at(3), demo: false, now: NOW });
    expect(read.status).toBe('ok');
    expect(read.freshness).toBe('fresh');
    expect(read.demo).toBe(false);
  });

  it('a failed read keeps the §1 error code and offers no data to render', () => {
    const read = failedRead<number>({ source: 'GET /api/v1/x', errorCode: 'ai_unavailable', requestId: 'req-1' });
    expect(read.status).toBe('failed');
    expect(read.data).toBeNull();
    expect(read.origin).toBe('none');
    expect(read.errorCode).toBe('ai_unavailable');
    expect(read.requestId).toBe('req-1');
  });
});

describe('funnel derivation', () => {
  it('a zero denominator yields null, not a fake 0% (0 traffic is not 0 quality)', () => {
    expect(conversionRate(5, 0)).toBeNull();
    expect(conversionRate(0, 0)).toBeNull();
    expect(conversionRate(-1, 10)).toBeNull();
  });

  it('rates round to three decimals and divide the right way', () => {
    expect(conversionRate(24, 100)).toBe(0.24);
    expect(conversionRate(1, 3)).toBeCloseTo(0.333, 3);
  });

  it('funnelRates pairs clicks/views and actions/clicks', () => {
    const rates = funnelRates({ views: 200, clicks: 50, actions: 5, reservations: 2, orders: 3, revenue: { amount: '0.00', currency: 'HKD' } });
    expect(rates.clickThrough).toBe(0.25);
    expect(rates.actionPerClick).toBe(0.1);
  });
});

describe('listing draft validation (§47 client-side)', () => {
  const base: ListingDraft = {
    name: '龍苑 Kitchen',
    tagline: '粤式小炒 · 沙田',
    description: '合成示例商戶。',
    phone: '+852 2600 0001',
    price_amount: '188.00',
  };

  it('accepts the seed-shaped draft unchanged', () => {
    expect(validateListingDraft(base)).toEqual({});
  });

  it('requires a name', () => {
    expect(validateListingDraft({ ...base, name: '   ' })).toEqual({ name: 'required' });
  });

  it('bounds lengths per field', () => {
    expect(validateListingDraft({ ...base, tagline: 'x'.repeat(61) })).toEqual({ tagline: 'too_long' });
    expect(validateListingDraft({ ...base, description: 'x'.repeat(2001) })).toEqual({ description: 'too_long' });
  });

  it('price must be a decimal string or blank; phone must be dialable', () => {
    expect(validateListingDraft({ ...base, price_amount: '12.345' })).toEqual({ price_amount: 'invalid' });
    expect(validateListingDraft({ ...base, price_amount: '' })).toEqual({});
    expect(validateListingDraft({ ...base, phone: 'abc' })).toEqual({ phone: 'invalid' });
  });

  it('dirty means "different from the loaded draft", field by field', () => {
    expect(listingDraftIsDirty(base, base)).toBe(false);
    expect(listingDraftIsDirty(base, { ...base, phone: '+852 2600 0002' })).toBe(true);
  });

  it('a blank price is dropped from the PATCH body instead of sent as 0 (blank is not a claim)', () => {
    const body = listingPatchBody({ ...base, price_amount: '  ' });
    expect(body).not.toHaveProperty('avg_price');
    expect(listingPatchBody(base)).toHaveProperty('avg_price', { amount: '188.00', currency: 'HKD' });
  });
});

describe('review queue summary (§27)', () => {
  function item(over: Partial<ReviewQueueItem>): ReviewQueueItem {
    return {
      id: over.id ?? Math.random().toString(36).slice(2),
      kind: 'guide',
      title: 't',
      summary: 's',
      actor: 'ai:seo',
      merchant_name: null,
      generated_by_ai: true,
      reviewed_by_human: false,
      submitted_at: null,
      status: 'pending',
      source: 'GET /api/v1/admin/moderation',
      demo: true,
      ...over,
    };
  }

  it('counts statuses, kinds and the AI items no human has checked', () => {
    const summary = summarizeQueue([
      item({ id: 'a' }),
      item({ id: 'b', kind: 'coupon', reviewed_by_human: true }),
      item({ id: 'c', kind: 'listing_change', generated_by_ai: false }),
      item({ id: 'd', status: 'approved' }),
      item({ id: 'e', status: 'rejected' }),
    ]);
    expect(summary.total).toBe(5);
    expect(summary.pending).toBe(3);
    expect(summary.approved).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.byKind).toEqual({ guide: 3, coupon: 1, listing_change: 1 });
    // b IS reviewed, c is not AI → unreviewed AI are a, d, e.
    expect(summary.unreviewedAi).toBe(3);
  });

  it('an empty queue summarizes to zeroes — the honest empty state', () => {
    const summary = summarizeQueue([]);
    expect(summary.total).toBe(0);
    expect(summary.unreviewedAi).toBe(0);
  });
});

// The fixture catalogue is the §109 surface: every row must announce itself as synthetic and
// stay deterministic across reloads, or the demo becomes noise dressed as a trend.
describe('console fixtures (§109/§155)', () => {
  it('unknown businesses resolve to null, not to a made-up merchant', () => {
    expect(fixtureMerchantOverview('m-does-not-exist', NOW)).toBeNull();
    expect(fixtureConversations('m-does-not-exist', NOW)).toBeNull();
    expect(fixtureListingDraft('m-does-not-exist')).toBeNull();
  });

  it('funnel figures are stable for a fixed instant and demo-labelled', () => {
    const first = fixtureMerchantOverview('m-lung-yuen', NOW);
    const second = fixtureMerchantOverview('m-lung-yuen', NOW);
    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    expect(first!.data_origin).toBe('demo');
    expect(first!.funnel.views).toBeGreaterThan(first!.funnel.clicks);
    expect(first!.revenue_definition).toContain('fixture');
  });

  it('every conversation and queue row carries the demo flag; one business keeps a provably empty inbox', () => {
    expect(fixtureConversations('m-lung-yuen', NOW)!.every((thread) => thread.demo)).toBe(true);
    expect(fixtureConversations(DEMO_CONSOLE_EMPTY_INBOX, NOW)).toEqual([]);
    expect(fixtureReviewQueue(NOW).every((item) => item.demo)).toBe(true);
    expect(summarizeQueue(fixtureReviewQueue(NOW)).unreviewedAi).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ §27 gate */

describe('AI provenance and the §27 publish gate', () => {
  const human: AiProvenance = { generated_by_ai: false, reviewed_by_human: false, actor: 'merchant', generated_at: null };
  const unapproved: AiProvenance = { generated_by_ai: true, reviewed_by_human: false, actor: 'ai:marketing', generated_at: null };
  const approved: AiProvenance = { generated_by_ai: true, reviewed_by_human: true, actor: 'ai:marketing', generated_at: null };

  it('classifies the three states without merging the two booleans', () => {
    expect(aiDraftState(human)).toBe('human');
    expect(aiDraftState(unapproved)).toBe('ai_unapproved');
    expect(aiDraftState(approved)).toBe('ai_approved');
  });

  it('closes the gate for AI content no human has checked, and only for that', () => {
    expect(publishGateOpen(human)).toBe(true);
    expect(publishGateOpen(unapproved)).toBe(false);
    expect(publishGateOpen(approved)).toBe(true);
  });

  it('counts the states a page must report', () => {
    expect(countByAiState([human, unapproved, approved, unapproved])).toEqual({
      human: 1,
      ai_approved: 1,
      ai_unapproved: 2,
    });
  });
});

describe('campaigns (§27)', () => {
  function campaign(over: Partial<MerchantCampaign>): MerchantCampaign {
    return {
      id: 'c1',
      name: 'draft',
      channel: 'in_app',
      status: 'draft',
      body: null,
      audience: null,
      provenance: { generated_by_ai: true, reviewed_by_human: false, actor: 'ai:marketing', generated_at: null },
      approved_by: null,
      published_at: null,
      created_at: null,
      evidence_fact_ids: [],
      demo: true,
      ...over,
    };
  }

  it('a published campaign is not "publishable" — that would be a second publish', () => {
    expect(campaignIsTerminal('published')).toBe(true);
    expect(campaignPublishable(campaign({ status: 'published' }))).toBe(false);
  });

  it('an unapproved AI draft is not publishable; a human one is', () => {
    expect(campaignPublishable(campaign({}))).toBe(false);
    expect(
      campaignPublishable(
        campaign({ provenance: { generated_by_ai: false, reviewed_by_human: false, actor: 'merchant', generated_at: null } }),
      ),
    ).toBe(true);
  });

  it('counts drafts, published and the drafts still waiting on a person', () => {
    const counts = campaignCounts([
      campaign({ id: 'a' }),
      campaign({ id: 'b', status: 'published' }),
      campaign({ id: 'c', provenance: { generated_by_ai: false, reviewed_by_human: false, actor: 'merchant', generated_at: null } }),
    ]);
    expect(counts).toEqual({ total: 3, drafts: 2, published: 1, awaitingHuman: 1 });
  });
});

/* --------------------------------------------------------------- §22 imports */

describe('import jobs (§22)', () => {
  it('maps only the platform status vocabulary, leaving an unknown status without invented progress', () => {
    const stages = importJobStages('queued');
    expect(stages[0]).toEqual({ key: 'queued', state: 'active' });
    expect(stages[1]?.state).toBe('pending');
    expect(importJobStages('who-knows').every((stage) => stage.state === 'pending')).toBe(true);
  });

  it('a terminal status fills every stage; a failure marks the last one failed', () => {
    expect(importJobStages('succeeded').every((stage) => stage.state === 'done')).toBe(true);
    const failed = importJobStages('failed');
    expect(failed.at(-1)?.state).toBe('failed');
  });

  it('terminality is the platform spelling, not the SDK union', () => {
    expect(importJobTerminal('succeeded')).toBe(true);
    expect(importJobTerminal('failed')).toBe(true);
    expect(importJobTerminal('running')).toBe(false);
    expect(importJobTerminal('done')).toBe(false);
  });

  it('flags low-confidence and evidence-less proposals — the rows a human must read', () => {
    const proposals = [
      { id: 'a', kind: 'product', name: 'A', price: null, category: null, confidence: 0.93, evidence_fact_ids: ['f1'], source_span: null },
      { id: 'b', kind: 'product', name: 'B', price: null, category: null, confidence: 0.4, evidence_fact_ids: [], source_span: null },
    ];
    expect(proposalIsLowConfidence(proposals[1]!)).toBe(true);
    expect(importProposalCounts(proposals)).toEqual({ total: 2, lowConfidence: 1, withoutEvidence: 1 });
  });
});

/* --------------------------------------------------------- reservations (§6) */

describe('reservation state machine (§6)', () => {
  function reservation(over: Partial<MerchantReservation>): MerchantReservation {
    return {
      id: 'r1',
      code: null,
      consumer_name: null,
      offering_title: null,
      party_size: 2,
      slot_start: null,
      status: 'requested',
      notes: null,
      created_at: null,
      contact: null,
      price: null,
      source: null,
      updated_at: null,
      demo: true,
      ...over,
    };
  }

  it('terminal states have no outgoing edge — a cancelled booking is not re-openable', () => {
    expect(nextReservationStates('cancelled')).toEqual([]);
    expect(nextReservationStates('completed')).toEqual([]);
    expect(nextReservationStates('no_show')).toEqual([]);
  });

  it('an unknown status offers no transitions rather than a guess', () => {
    expect(nextReservationStates('mystery')).toEqual([]);
  });

  it('the guest label never invents a name: name → contact name → phone → null', () => {
    expect(reservationGuestLabel(reservation({ consumer_name: 'Chan' }))).toBe('Chan');
    expect(reservationGuestLabel(reservation({ contact: { name: 'Lee', phone: '+852', email: null } }))).toBe('Lee');
    expect(reservationGuestLabel(reservation({ contact: { name: null, phone: '+852', email: null } }))).toBe('+852');
    expect(reservationGuestLabel(reservation({}))).toBeNull();
  });

  it('covers counts only the bookings still standing', () => {
    const counts = reservationCounts([
      reservation({ id: 'a', party_size: 2, status: 'requested' }),
      reservation({ id: 'b', party_size: 4, status: 'seated' }),
      reservation({ id: 'c', party_size: 9, status: 'cancelled' }),
    ]);
    expect(counts).toEqual({ total: 3, awaitingDecision: 1, seated: 1, cancelled: 1, covers: 6 });
  });

  it('day filtering uses the Hong Kong day, not the server UTC day (§112)', () => {
    // 2026-09-21T23:30Z is 2026-09-22 07:30 in Hong Kong.
    expect(reservationDayKey('2026-09-21T23:30:00Z')).toBe('2026-09-22');
    const rows = [
      reservation({ id: 'a', slot_start: '2026-09-21T23:30:00Z' }),
      reservation({ id: 'b', slot_start: '2026-09-22T04:00:00Z' }),
    ];
    expect(reservationsOnDay(rows, '2026-09-22', NOW).map((row) => row.id)).toEqual(['a', 'b']);
    expect(reservationsOnDay(rows, '2026-09-21', NOW)).toEqual([]);
  });
});

/* ------------------------------------------------------------- §54/§55 reviews */

describe('review intelligence evidence (§55)', () => {
  function intel(over: Partial<ReviewIntelligence>): ReviewIntelligence {
    return {
      summary: 's',
      themes: [],
      evidence_review_ids: [],
      generated_at: null,
      model: 'mock',
      published_reviews: 3,
      average_rating: 4.2,
      distribution: {},
      provenance: { generated_by_ai: true, reviewed_by_human: false, actor: 'ai:review', generated_at: null },
      demo: true,
      ...over,
    };
  }

  it('names the themes that cite nothing — the ones a reviewer must not trust', () => {
    const coverage = reviewEvidenceCoverage(
      intel({
        themes: [
          { label: 'service', sentiment: 'positive', mentions: 3, review_ids: ['r1'] },
          { label: 'noise', sentiment: 'negative', mentions: 1, review_ids: [] },
        ],
        evidence_review_ids: ['r1'],
      }),
    );
    expect(coverage.themes).toBe(2);
    expect(coverage.themesWithEvidence).toBe(1);
    expect(coverage.uncoveredThemes).toEqual(['noise']);
    expect(coverage.hasEvidence).toBe(true);
  });

  it('a summary with no evidence says so rather than being treated as a conclusion', () => {
    expect(reviewEvidenceCoverage(intel({})).hasEvidence).toBe(false);
  });

  it('distribution shares are null when there is no total — 0 reviews is not 0%', () => {
    expect(distributionShares({}).every((bucket) => bucket.share === null)).toBe(true);
    const shares = distributionShares({ '5': 3, '4': 1 });
    expect(shares[0]).toEqual({ rating: 5, count: 3, share: 0.75 });
    expect(shares[1]).toEqual({ rating: 4, count: 1, share: 0.25 });
  });
});

/* ------------------------------------------------------------- §56 analytics */

describe('analytics field provenance (§19/§109)', () => {
  it('a field is provided only when the payload stated a finite number or a money amount', () => {
    expect(analyticsProvidedFields({ views: 3, clicks: 0, notes: 'x', revenue: { amount: '10.00', currency: 'HKD' } })).toEqual([
      'views',
      'clicks',
      'revenue',
    ]);
    expect(analyticsProvidedFields(null)).toEqual([]);
  });

  it('a missing metric is not promoted to a 0', () => {
    expect(analyticsFieldProvided({ provided: ['views'] }, 'views')).toBe(true);
    expect(analyticsFieldProvided({ provided: ['views'] }, 'leads')).toBe(false);
  });

  it('the platform event series is normalised, sorted, and drops rows it cannot read', () => {
    expect(
      analyticsEventSeries([
        { day: '2026-09-02', events: 5 },
        { date: '2026-09-01', events: 3 },
        { day: '2026-09-03', events: 'nope' },
      ]),
    ).toEqual([
      { date: '2026-09-01', events: 3 },
      { date: '2026-09-02', events: 5 },
    ]);
  });
});

/* --------------------------------------------------------- §9 admin helpers */

describe('moderation case vocabulary (§9/§127)', () => {
  it('case status is open|resolved; an unrecognised value is open, not resolved', () => {
    expect(moderationCaseStatusOf('resolved')).toBe('resolved');
    expect(moderationCaseStatusOf('closed')).toBe('open');
    expect(moderationCaseStatusOf(null)).toBe('open');
  });

  it('the decision is read from resolution.decision and must be one of the three', () => {
    expect(moderationDecisionOf({ decision: 'published' })).toBe('published');
    expect(moderationDecisionOf({ decision: 'approved' })).toBeNull();
    expect(moderationDecisionOf(null)).toBeNull();
  });

  it('an open case is pending; a resolved case with no stated decision is still pending, never approved', () => {
    expect(moderationDisplayStatus('open', null)).toBe('pending');
    expect(moderationDisplayStatus('resolved', null)).toBe('pending');
    expect(moderationDisplayStatus('resolved', 'published')).toBe('approved');
    expect(moderationDisplayStatus('resolved', 'rejected')).toBe('rejected');
  });

  it('only an open review case is resolvable on the served route', () => {
    expect(moderationCaseResolvable({ case_status: 'open', subject_type: 'review' })).toBe(true);
    expect(moderationCaseResolvable({ case_status: 'resolved', subject_type: 'review' })).toBe(false);
    expect(moderationCaseResolvable({ case_status: 'open', subject_type: 'merchant' })).toBe(false);
  });
});

describe('admin Analytics Agent answer (§126)', () => {
  it('parses the served {metric, value} evidence pairs', () => {
    const parsed = parseAdminAskAnswer({
      answer: 'There are 3 merchants.',
      answer_source: 'sql',
      read_only: true,
      degraded: true,
      degraded_reason: 'no_llm_key_configured',
      model_used: null,
      evidence: [
        { metric: 'merchants.total', value: 3 },
        { metric: 'orders.gmv', value: '12.00' },
      ],
      as_of: '2026-09-22T08:00:00Z',
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.evidence).toEqual([
      { label: 'merchants.total', value: '3' },
      { label: 'orders.gmv', value: '12.00' },
    ]);
    expect(parsed!.model).toBeNull();
    expect(parsed!.degraded_reason).toBe('no_llm_key_configured');
    expect(parsed!.read_only).toBe(true);
  });

  it('an answer with no text is not an answer', () => {
    expect(parseAdminAskAnswer({ evidence: [] })).toBeNull();
    expect(parseAdminAskAnswer(null)).toBeNull();
  });
});

describe('search analytics derivation (§9/§109)', () => {
  it('keeps unknown numbers null rather than zero', () => {
    expect(searchDailySeries([{ day: '2026-09-01', sessions: 2 }, { sessions: 5 }])).toEqual([
      { day: '2026-09-01', sessions: 2, searches: null, fulfilled_intents: null },
    ]);
  });

  it('the fulfilment share is null when nothing was searched — no denominator, no rate', () => {
    expect(searchFulfilmentShare(0, 0)).toBeNull();
    expect(searchFulfilmentShare(null, 4)).toBeNull();
    expect(searchFulfilmentShare(10, 4)).toBe(0.4);
  });
});

/* --------------------------------------------------- §48/§22 misc predicates */

describe('verification, handoff, knowledge and offerings', () => {
  it('never upgrades an unrecognised verification status into "verified"', () => {
    expect(verificationStateOf('verified')).toBe('verified');
    expect(verificationStateOf('in_review')).toBe('pending');
    expect(verificationStateOf('not_submitted')).toBe('unverified');
    expect(verificationStateOf('something_else')).toBe('unknown');
    expect(verificationStateOf(null)).toBe('unknown');
  });

  it('handoff actions are the two the route accepts', () => {
    expect(isHandoffAction('accepted')).toBe(true);
    expect(isHandoffAction('resolved')).toBe(true);
    expect(isHandoffAction('closed')).toBe(false);
  });

  it('a thread needs a human when it is handed off or has an open handoff row', () => {
    expect(threadNeedsHuman({ status: 'handoff', handoffs: [] })).toBe(true);
    expect(
      threadNeedsHuman({
        status: 'open',
        handoffs: [{ id: 'h', reason: null, status: 'open', created_at: null, resolved_at: null }],
      }),
    ).toBe(true);
    expect(threadNeedsHuman({ status: 'open', handoffs: [] })).toBe(false);
  });

  it('an AI-authored turn is labelled by its run id or its role', () => {
    expect(messageIsAiAuthored({ id: 'm', role: 'assistant', content: 'x', created_at: null, agent_run_id: null, fact_ids: [], degraded: false })).toBe(true);
    expect(messageIsAiAuthored({ id: 'm', role: 'consumer', content: 'x', created_at: null, agent_run_id: 'run-1', fact_ids: [], degraded: false })).toBe(true);
    expect(messageIsAiAuthored({ id: 'm', role: 'consumer', content: 'x', created_at: null, agent_run_id: null, fact_ids: [], degraded: false })).toBe(false);
  });

  it('knowledge documents are only "indexed" in the states the platform names', () => {
    expect(knowledgeDocumentIndexed({ status: 'indexed' })).toBe(true);
    expect(knowledgeDocumentIndexed({ status: 'pending' })).toBe(false);
    const summary = knowledgeSummary([
      { id: 'a', kind: null, title: null, source_uri: null, mime_type: null, lang: null, status: 'indexed', error: null, chunk_count: 3, created_at: null, updated_at: null, demo: true },
      { id: 'b', kind: null, title: null, source_uri: null, mime_type: null, lang: null, status: 'pending', error: null, chunk_count: null, created_at: null, updated_at: null, demo: true },
    ]);
    expect(summary).toEqual({ documents: 2, chunks: 3, indexed: 1, awaitingIndex: 1, failed: 0 });
    expect(knowledgeSummary([]).chunks).toBeNull();
  });

  it('the offering form requires a title and a well-formed price, and drops a blank price', () => {
    expect(validateOfferingDraft(emptyOfferingDraft())).toEqual({ title: 'required' });
    expect(validateOfferingDraft({ title: 'x', kind: 'product', description: '', price_amount: '12.345', currency: 'HKD' })).toEqual({
      price_amount: 'invalid',
    });
    expect(offeringDraftBody({ title: ' x ', kind: 'product', description: '', price_amount: '  ', currency: 'HKD' })).not.toHaveProperty('price');
  });

  it('the agent config requires a greeting and a probability threshold, and omits a blank one', () => {
    const blank = emptyAgentConfigDraft();
    expect(validateAgentConfigDraft(blank).greeting).toBe('required');
    expect(validateAgentConfigDraft({ ...blank, greeting: 'hi', tone: 'friendly', handoff_threshold: '85' }).handoff_threshold).toBe('invalid');
    expect(validateAgentConfigDraft({ ...blank, greeting: 'hi', tone: 'friendly', handoff_threshold: '0.55' })).toEqual({});
  });
});
