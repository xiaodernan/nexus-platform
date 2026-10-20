'use client';

import { useState } from 'react';
import { Button, Icon, Input, Textarea } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import {
  AGENT_CONFIG_LIMITS,
  agentConfigBody,
  agentConfigDraftFrom,
  emptyAgentConfigDraft,
  validateAgentConfigDraft,
  type AiAgentConfig,
  type AiAgentConfigDraft,
  type AiAgentConfigErrors,
} from '@/lib/console-shared';

const ENDPOINT = 'POST /api/v1/merchant/ai-agent/config';

/**
 * The §5 AI-agent settings form. The greeting is required because the agent speaks it to customers,
 * and the handoff threshold must be a probability — "85" and "0.85" are different promises, so "85"
 * is invalid rather than silently divided by 100.
 *
 * The read of the *current* config is a contract gap (§5 documents the write only), so `initial` may
 * be `null`: the form then starts blank and says why, rather than pre-filling invented values.
 */
export function AgentConfigForm({
  locale,
  initial,
  bffPath,
}: {
  locale: string;
  initial: AiAgentConfig | null;
  bffPath?: string;
}) {
  const dict = getDict(locale);
  const copy = dict.console.settings.agent;
  const common = dict.console.common;
  const [draft, setDraft] = useState<AiAgentConfigDraft>(() =>
    initial ? agentConfigDraftFrom(initial) : emptyAgentConfigDraft(),
  );
  const [errors, setErrors] = useState<AiAgentConfigErrors>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; code: string | null } | null>(null);

  const wired = typeof bffPath === 'string' && bffPath.length > 0;

  function field<K extends keyof AiAgentConfigDraft>(key: K, value: AiAgentConfigDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    const found = validateAgentConfigDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setResult(null);
    if (!wired) {
      setResult({ ok: true, code: null });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(bffPath as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(agentConfigBody(draft)),
      });
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        setResult({ ok: false, code: envelope?.error?.code ?? String(response.status) });
      } else {
        setResult({ ok: true, code: null });
      }
    } catch {
      setResult({ ok: false, code: 'upstream_unreachable' });
    } finally {
      setBusy(false);
    }
  }

  const errorText = (key: keyof AiAgentConfigErrors, limit: number): string | undefined => {
    const code = errors[key];
    if (!code) return undefined;
    if (code === 'too_long') return dict.console.listings.errors.too_long(limit);
    return code === 'required' ? dict.console.listings.errors.required : dict.console.listings.errors.invalid;
  };

  return (
    <div className="flex flex-col gap-3">
      {initial === null ? (
        <p className="flex items-start gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs text-ink-muted">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          {copy.notConfigured}
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-xs text-ink-strong">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => field('enabled', event.target.checked)}
          className="h-4 w-4 rounded border-line"
        />
        {copy.enabled}
      </label>

      <Input
        label={copy.greeting}
        size="sm"
        required
        maxLength={AGENT_CONFIG_LIMITS.greeting}
        value={draft.greeting}
        error={errorText('greeting', AGENT_CONFIG_LIMITS.greeting)}
        onChange={(event) => field('greeting', event.target.value)}
      />
      <Input
        label={copy.tone}
        size="sm"
        required
        value={draft.tone}
        error={errorText('tone', AGENT_CONFIG_LIMITS.greeting)}
        onChange={(event) => field('tone', event.target.value)}
      />
      <Input
        label={copy.threshold}
        size="sm"
        inputMode="decimal"
        value={draft.handoff_threshold}
        error={errorText('handoff_threshold', AGENT_CONFIG_LIMITS.greeting)}
        onChange={(event) => field('handoff_threshold', event.target.value)}
      />
      <Input
        label={copy.languages}
        size="sm"
        maxLength={AGENT_CONFIG_LIMITS.languages}
        value={draft.languages}
        error={errorText('languages', AGENT_CONFIG_LIMITS.languages)}
        onChange={(event) => field('languages', event.target.value)}
      />
      <Textarea
        label={copy.outsideHours}
        rows={3}
        maxLength={AGENT_CONFIG_LIMITS.outside_hours_message}
        value={draft.outside_hours_message}
        error={errorText('outside_hours_message', AGENT_CONFIG_LIMITS.outside_hours_message)}
        onChange={(event) => field('outside_hours_message', event.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" shape="md" loading={busy} onClick={() => void save()}>
          {busy ? copy.saving : copy.save}
        </Button>
        {initial?.updated_by ? (
          <span className="text-2xs text-ink-faint">{copy.updatedBy(initial.updated_by)}</span>
        ) : null}
      </div>

      {result ? (
        <p className="flex max-w-2xl items-start gap-1.5 text-2xs leading-relaxed text-ink-muted">
          <Icon name={result.ok ? 'info' : 'warning'} size={12} className="mt-0.5 shrink-0" />
          {result.ok
            ? wired
              ? copy.saved
              : `${common.demoActionTitle}. ${copy.demoSave} ${common.demoActionText(ENDPOINT)}`
            : common.actionFailed(result.code ?? 'upstream_unreachable')}
        </p>
      ) : (
        <p className="max-w-2xl text-2xs leading-relaxed text-ink-faint">
          {wired ? copy.saved : `${dict.console.notWiredText} ${ENDPOINT}`}
        </p>
      )}
    </div>
  );
}
