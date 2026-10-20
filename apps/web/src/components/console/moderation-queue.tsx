'use client';

import { useState } from 'react';
import { Badge, Button, Icon, Input, Select } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { MODERATION_DECISIONS, moderationCaseResolvable, moderationDisplayStatus } from '@/lib/console-shared';
import type { AdminModerationCase } from '@/lib/console-admin';

const ENDPOINT = 'POST /api/v1/admin/moderation/{case_id}/resolve';

/**
 * The §9/§127 moderation queue. The action is a *decision + note* pair, and it is audited — so the
 * UI never offers a one-click "approve": it opens a confirm step, the note is written to the audit
 * record, and only then does the POST fire. The decision vocabulary is the review's
 * (`published|rejected|flagged`), not a verdict word, because that is what the platform accepts.
 *
 * Only `open` cases whose subject is a review are actionable — the route itself refuses anything
 * else, so the page says so rather than offering a button the platform will reject.
 */
export function ModerationQueue({
  cases,
  locale,
  bffPath,
}: {
  cases: AdminModerationCase[];
  locale: string;
  bffPath?: string;
}) {
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.moderation;
  const common = dict.console.common;
  const wired = typeof bffPath === 'string' && bffPath.length > 0;

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [decision, setDecision] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<Record<string, { ok: boolean; code: string | null }>>({});

  async function resolve(item: AdminModerationCase) {
    const chosen = decision[item.case_id] ?? MODERATION_DECISIONS[0];
    const body = { decision: chosen, note: (note[item.case_id] ?? '').trim() };

    if (!wired) {
      setOpen((current) => ({ ...current, [item.case_id]: false }));
      setResult((current) => ({ ...current, [item.case_id]: { ok: true, code: null } }));
      return;
    }
    setBusy((current) => ({ ...current, [item.case_id]: true }));
    try {
      const response = await fetch(`${bffPath as string}/${encodeURIComponent(item.case_id)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        setResult((current) => ({ ...current, [item.case_id]: { ok: false, code: envelope?.error?.code ?? String(response.status) } }));
      } else {
        setResult((current) => ({ ...current, [item.case_id]: { ok: true, code: null } }));
      }
    } catch {
      setResult((current) => ({ ...current, [item.case_id]: { ok: false, code: 'upstream_unreachable' } }));
    } finally {
      setBusy((current) => ({ ...current, [item.case_id]: false }));
      setOpen((current) => ({ ...current, [item.case_id]: false }));
    }
  }

  return (
    <ul className="flex flex-col gap-3">
      {cases.map((item) => {
        const actionable = moderationCaseResolvable({ case_status: item.case_status, subject_type: item.subject_type });
        const display = moderationDisplayStatus(item.case_status, item.resolution);
        const state = result[item.case_id];
        const isOpen = open[item.case_id] === true;
        return (
          <li key={item.case_id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={item.case_status === 'open' ? 'warning' : 'neutral'} size="sm">
                {item.case_status === 'open' ? copy.filterOpen : copy.filterResolved}
              </Badge>
              <Badge tone={display === 'approved' ? 'positive' : display === 'rejected' ? 'danger' : 'neutral'} size="sm">
                {copy.displayStatus[display]}
              </Badge>
              {item.subject_type ? <Badge tone="outline" size="sm">{copy.subjectType}: {item.subject_type}</Badge> : null}
              {item.demo ? <Badge tone="outline" size="sm">demo</Badge> : null}
              <span className="ml-auto font-mono text-2xs text-ink-faint">{item.case_id}</span>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-ink-faint">
              {item.reason ? <span>{copy.reason}: {item.reason}</span> : null}
              {item.policy ? <span>{copy.policy}: {item.policy}</span> : null}
              {item.auto_action ? <span>{copy.autoAction}: {item.auto_action}</span> : null}
              <span>{copy.created}: {item.created_at ?? '—'}</span>
              {item.resolved_at ? <span>{copy.resolvedAt}: {item.resolved_at}</span> : null}
            </div>

            {item.subject_known && item.subject ? (
              <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-muted p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {item.subject.rating ? (
                    <Badge tone="neutral" size="sm" icon="star">{copy.rating}: {item.subject.rating}</Badge>
                  ) : null}
                  {item.subject.status ? <Badge tone="neutral" size="sm">{copy.subject}: {item.subject.status}</Badge> : null}
                  {item.subject.language ? <Badge tone="outline" size="sm">{copy.language}: {item.subject.language}</Badge> : null}
                </div>
                {item.subject.excerpt ? (
                  <p className="max-w-3xl text-xs leading-relaxed text-ink-strong">{item.subject.excerpt}</p>
                ) : null}
                {item.subject.merchant ? (
                  <p className="text-2xs text-ink-muted">
                    {copy.merchant}: {item.subject.merchant.name ?? item.subject.merchant.id ?? '—'}
                    {item.subject.merchant.status ? ` · ${copy.merchantStatus}: ${item.subject.merchant.status}` : null}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-2xs text-ink-muted">{copy.subjectMissing}</p>
            )}

            {item.resolution ? (
              <p className="text-2xs text-ink-muted">
                {copy.resolution}: <span className="font-mono">{copy.decisions[item.resolution] ?? item.resolution}</span>
                {item.resolution_note ? ` · ${copy.resolutionNote}: ${item.resolution_note}` : null}
              </p>
            ) : null}

            {actionable ? (
              isOpen ? (
                <div className="flex flex-col gap-2 rounded-md border border-warning/70 bg-warning-soft/50 p-3">
                  <p className="text-xs font-medium text-ink-strong">{copy.confirmTitle}</p>
                  <p className="max-w-2xl text-2xs leading-relaxed text-ink-muted">{copy.confirmText(item.case_id)}</p>
                  <Select
                    label={copy.decision}
                    size="sm"
                    value={decision[item.case_id] ?? MODERATION_DECISIONS[0]}
                    onChange={(value) => setDecision((current) => ({ ...current, [item.case_id]: value }))}
                    options={MODERATION_DECISIONS.map((value) => ({ value, label: copy.decisions[value] ?? value }))}
                  />
                  <Input
                    label={copy.note}
                    hint={copy.noteHint}
                    size="sm"
                    maxLength={500}
                    value={note[item.case_id] ?? ''}
                    onChange={(event) => setNote((current) => ({ ...current, [item.case_id]: event.target.value }))}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="primary"
                      size="xs"
                      shape="md"
                      loading={busy[item.case_id] === true}
                      onClick={() => void resolve(item)}
                    >
                      {copy.resolve}
                    </Button>
                    <Button variant="ghost" size="xs" shape="md" onClick={() => setOpen((current) => ({ ...current, [item.case_id]: false }))}>
                      {common.cancel}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" shape="md" onClick={() => setOpen((current) => ({ ...current, [item.case_id]: true }))}>
                    {copy.resolve}
                  </Button>
                  {!wired ? <span className="text-2xs text-ink-faint">{dict.console.notWiredText} {ENDPOINT}</span> : null}
                </div>
              )
            ) : (
              <p className="text-2xs text-ink-faint">{copy.notResolvable}</p>
            )}

            {state ? (
              <p className="flex max-w-2xl items-start gap-1.5 text-2xs leading-relaxed text-ink-muted">
                <Icon name={state.ok ? 'info' : 'warning'} size={12} className="mt-0.5 shrink-0" />
                {state.ok
                  ? wired
                    ? copy.resolved
                    : `${common.demoActionTitle}. ${copy.demoResolve} ${common.demoActionText(ENDPOINT)}`
                  : copy.resolveFailed(state.code ?? 'upstream_unreachable')}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
