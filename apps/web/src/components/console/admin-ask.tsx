'use client';

import { useState } from 'react';
import { Badge, Button, Icon, Input } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { parseAdminAskAnswer, type AdminAskAnswer } from '@/lib/console-shared';

const ENDPOINT = 'POST /api/v1/admin/ai/ask';

/**
 * The §126 Admin Analytics Agent ask-box. **Read-only**: the agent has no write tools, and the
 * platform refuses a question whose leading verb is a mutation (422) rather than quietly answering
 * it — that refusal is rendered as itself, not as a generic error.
 *
 * The answer's own `degraded` / `degraded_reason` / `answer_source` are surfaced verbatim: in this
 * build the platform ships no LLM client, so the answer comes from aggregate SQL and says so.
 */
export function AdminAsk({ locale, bffPath }: { locale: string; bffPath?: string }) {
  const dict = getDict(locale);
  const copy = dict.console.adminConsole.ai;
  const common = dict.console.common;
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AdminAskAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const wired = typeof bffPath === 'string' && bffPath.length > 0;

  async function ask() {
    if (question.trim() === '') return;
    setAnswer(null);
    setFailure(null);
    if (!wired) {
      setFailure('not_wired');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(bffPath as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ question: question.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const envelope = payload as { error?: { code?: string } } | null;
        setFailure(envelope?.error?.code ?? String(response.status));
        return;
      }
      const parsed = parseAdminAskAnswer(payload);
      if (!parsed) {
        setFailure('invalid_payload');
        return;
      }
      setAnswer(parsed);
    } catch {
      setFailure('upstream_unreachable');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-3xl text-xs leading-relaxed text-ink-muted">{copy.askIntro}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Input
          label={copy.ask}
          size="sm"
          containerClassName="min-w-[18rem] flex-1"
          maxLength={500}
          placeholder={copy.askPlaceholder}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <Button variant="primary" size="sm" shape="md" loading={busy} onClick={() => void ask()}>
          {busy ? copy.asking : copy.ask}
        </Button>
        <Badge tone="neutral" size="sm" icon="lock">
          {common.readOnly}
        </Badge>
      </div>

      {failure ? (
        <p className="flex max-w-3xl items-start gap-1.5 text-xs text-warning">
          <Icon name="warning" size={13} className="mt-0.5 shrink-0" />
          {failure === 'not_wired'
            ? `${dict.console.notWiredText} ${ENDPOINT}`
            : failure === 'read_only'
              ? copy.askRefused
              : copy.askFailed(failure)}
        </p>
      ) : null}

      {answer ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent" size="sm" icon="ai">
              {copy.askAnswer}
            </Badge>
            {answer.answer_source ? (
              <Badge tone="neutral" size="sm">{answer.answer_source}</Badge>
            ) : null}
            <Badge tone="neutral" size="sm" icon="lock">
              {copy.askReadOnly}
            </Badge>
          </div>
          <p className="max-w-3xl text-sm leading-relaxed text-ink-strong">{answer.answer}</p>

          {answer.degraded ? (
            <p className="flex max-w-3xl items-start gap-1.5 text-2xs leading-relaxed text-warning">
              <Icon name="warning" size={12} className="mt-0.5 shrink-0" />
              {copy.askDegraded(answer.degraded_reason ?? '—')}
            </p>
          ) : null}

          {answer.evidence.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{copy.askEvidence}</span>
              <ul className="flex flex-wrap gap-1.5">
                {answer.evidence.map((entry) => (
                  <li
                    key={entry.label}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2 py-1 font-mono text-2xs text-ink-muted"
                  >
                    <span>{entry.label}</span>
                    {entry.value !== null ? <span className="text-ink-strong">{entry.value}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {!answer && !failure ? <p className="text-2xs text-ink-faint">{copy.askEmpty}</p> : null}
    </div>
  );
}
