'use client';

import { useState } from 'react';
import { Button, Icon, Input, Select, Textarea } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import {
  emptyOfferingDraft,
  offeringDraftBody,
  OFFERING_KINDS,
  OFFERING_LIMITS,
  validateOfferingDraft,
  type OfferingDraft,
  type OfferingDraftErrors,
} from '@/lib/console-shared';

const ENDPOINT = 'POST /api/v1/merchant/offerings';

/**
 * The §5 offering create form. A blank price is "no stated price" and is dropped from the body —
 * sending 0 would be a claim about the price (§19). Nothing is written until the merchant presses
 * submit, and a created offering is a draft that still passes the §27 gate before it is public.
 */
export function OfferingForm({ locale, bffPath }: { locale: string; bffPath?: string }) {
  const dict = getDict(locale);
  const copy = dict.console.offerings;
  const common = dict.console.common;
  const [draft, setDraft] = useState<OfferingDraft>(() => emptyOfferingDraft());
  const [errors, setErrors] = useState<OfferingDraftErrors>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; code: string | null } | null>(null);

  const wired = typeof bffPath === 'string' && bffPath.length > 0;

  function field<K extends keyof OfferingDraft>(key: K, value: OfferingDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function errorText(key: keyof OfferingDraftErrors): string | undefined {
    const code = errors[key];
    if (!code) return undefined;
    if (code === 'too_long') return dict.console.listings.errors.too_long(OFFERING_LIMITS[key as 'title' | 'description' | 'price_amount'] ?? 200);
    return code === 'required' ? dict.console.listings.errors.required : dict.console.listings.errors.invalid;
  }

  async function submit() {
    const found = validateOfferingDraft(draft);
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
        body: JSON.stringify(offeringDraftBody(draft)),
      });
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        setResult({ ok: false, code: envelope?.error?.code ?? String(response.status) });
      } else {
        setResult({ ok: true, code: null });
        setDraft(emptyOfferingDraft());
      }
    } catch {
      setResult({ ok: false, code: 'upstream_unreachable' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label={copy.fields.title}
          size="sm"
          required
          maxLength={OFFERING_LIMITS.title}
          value={draft.title}
          error={errorText('title')}
          onChange={(event) => field('title', event.target.value)}
        />
        <Select
          label={copy.fields.kind}
          size="sm"
          value={draft.kind}
          onChange={(value) => field('kind', value)}
          options={OFFERING_KINDS.map((kind) => ({ value: kind, label: copy.kinds[kind] ?? kind }))}
        />
        <Input
          label={copy.fields.price_amount}
          size="sm"
          inputMode="decimal"
          maxLength={OFFERING_LIMITS.price_amount}
          value={draft.price_amount}
          error={errorText('price_amount')}
          onChange={(event) => field('price_amount', event.target.value)}
        />
        <Input
          label={copy.fields.currency}
          size="sm"
          required
          value={draft.currency}
          error={errorText('currency')}
          onChange={(event) => field('currency', event.target.value)}
        />
      </div>
      <Textarea
        label={copy.fields.description}
        rows={3}
        maxLength={OFFERING_LIMITS.description}
        value={draft.description}
        error={errorText('description')}
        onChange={(event) => field('description', event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" shape="md" loading={busy} onClick={() => void submit()}>
          {busy ? common.submitting : copy.create}
        </Button>
        {result ? (
          <span className="flex max-w-2xl items-start gap-1.5 text-2xs leading-relaxed text-ink-muted">
            <Icon name={result.ok ? 'info' : 'warning'} size={12} className="mt-0.5 shrink-0" />
            {result.ok
              ? wired
                ? copy.created
                : `${common.demoActionTitle}. ${common.demoActionText(ENDPOINT)}`
              : copy.createFailed(result.code ?? 'upstream_unreachable')}
          </span>
        ) : (
          <span className="text-2xs text-ink-faint">{wired ? copy.createTitle : copy.notWired}</span>
        )}
      </div>
    </div>
  );
}
