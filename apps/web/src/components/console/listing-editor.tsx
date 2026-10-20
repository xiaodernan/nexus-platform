'use client';

/**
 * The merchant's own profile/offering edit form (§47: the merchant controls their own data).
 *
 * Three honesty rules the whole component is built around:
 *  1. Draft edits are local state only — the banner says so, and nothing is sent until submit.
 *  2. Client-side validation mirrors the platform's column rules (`console-shared.validateListingDraft`),
 *     so a rejected submit shows the real reason, not a spinner that never ends.
 *  3. In demo mode submit is a *labelled demo action*: it names the endpoint it did not call
 *     (`PATCH /api/v1/merchant/businesses/{id}`) instead of faking a success toast. In live mode it
 *     really POSTs through the BFF and renders the §1 error envelope verbatim when the platform says no.
 */

import { useMemo, useState } from 'react';
import { Button, Icon, Textarea, Input } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { LocaleDemoBadge } from '../locale-badges';
import {
  LISTING_LIMITS,
  listingDraftIsDirty,
  listingPatchBody,
  validateListingDraft,
  type ListingDraft,
  type ListingDraftErrors,
  type ListingDraftField,
} from '@/lib/console-shared';

const PATCH_ENDPOINT = 'PATCH /api/v1/merchant/businesses/{id}';

type SubmitResult =
  | { kind: 'idle' }
  | { kind: 'demo' }
  | { kind: 'ok' }
  | { kind: 'failed'; code: string };

export function ListingEditor({
  locale,
  mode,
  businessId,
  initial,
}: {
  locale: string;
  mode: 'mock' | 'live';
  businessId: string;
  initial: ListingDraft;
}) {
  const dict = getDict(locale);
  const copy = dict.console.listings;
  const [draft, setDraft] = useState<ListingDraft>(initial);
  const [errors, setErrors] = useState<ListingDraftErrors>({});
  const [result, setResult] = useState<SubmitResult>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const dirty = useMemo(() => listingDraftIsDirty(initial, draft), [initial, draft]);

  const set = (field: ListingDraftField) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setResult({ kind: 'idle' });
  };

  const errorText = (field: ListingDraftField): string | undefined => {
    const code = errors[field];
    if (!code) return undefined;
    if (code === 'too_long') return copy.errors.too_long(LISTING_LIMITS[field]);
    return copy.errors[code];
  };

  async function submit() {
    const found = validateListingDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setResult({ kind: 'failed', code: 'validation_error' });
      return;
    }
    if (mode === 'mock') {
      // No fake success: nothing leaves the browser in demo mode.
      setResult({ kind: 'demo' });
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/nexus/platform/merchant/businesses/${encodeURIComponent(businessId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(listingPatchBody(draft)),
      });
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        setResult({ kind: 'failed', code: envelope?.error?.code ?? String(response.status) });
      } else {
        setResult({ kind: 'ok' });
      }
    } catch {
      setResult({ kind: 'failed', code: 'upstream_unreachable' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-xs leading-relaxed text-ink-muted">{copy.editIntro}</p>

      {dirty ? (
        <p className="flex items-start gap-2 rounded-md border border-accent-line bg-accent-soft px-3 py-2 text-xs text-ink-strong">
          <Icon name="settings" size={14} className="mt-0.5 shrink-0 text-accent" />
          {copy.dirtyBanner}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={copy.fields.name}
          required
          value={draft.name}
          maxLength={LISTING_LIMITS.name + 20}
          error={errorText('name')}
          onChange={(event) => set('name')(event.target.value)}
        />
        <Input
          label={copy.fields.tagline}
          value={draft.tagline}
          maxLength={LISTING_LIMITS.tagline + 20}
          error={errorText('tagline')}
          onChange={(event) => set('tagline')(event.target.value)}
        />
        <Input
          label={copy.fields.phone}
          value={draft.phone}
          inputMode="tel"
          error={errorText('phone')}
          onChange={(event) => set('phone')(event.target.value)}
        />
        <Input
          label={copy.fields.price_amount}
          value={draft.price_amount}
          inputMode="decimal"
          hint={copy.hints.price_amount}
          error={errorText('price_amount')}
          onChange={(event) => set('price_amount')(event.target.value)}
        />
      </div>
      <Textarea
        label={copy.fields.description}
        value={draft.description}
        rows={5}
        error={errorText('description')}
        onChange={(event) => set('description')(event.target.value)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" shape="md" loading={busy}>
          {busy ? copy.submitting : copy.submit}
        </Button>
        <Button
          type="button"
          variant="outline"
          shape="md"
          disabled={!dirty}
          onClick={() => {
            setDraft(initial);
            setErrors({});
            setResult({ kind: 'idle' });
          }}
        >
          {copy.reset}
        </Button>
        {mode === 'mock' ? <LocaleDemoBadge locale={locale} /> : null}
      </div>

      <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
        <Icon name="shield" size={14} className="mt-0.5 shrink-0 text-ink-faint" />
        {copy.gateNote}
      </p>

      {result.kind === 'demo' ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-warning/70 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-ink-strong">
          <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-warning" />
          <span>
            <span className="font-semibold">{copy.demoSubmittedTitle} · </span>
            {copy.demoSubmittedText(PATCH_ENDPOINT)}
          </span>
        </p>
      ) : null}
      {result.kind === 'ok' ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-positive/50 bg-positive-soft px-3 py-2 text-xs text-ink-strong">
          <Icon name="check" size={14} className="mt-0.5 shrink-0 text-positive" />
          {copy.liveSubmittedTitle}
        </p>
      ) : null}
      {result.kind === 'failed' ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-ink-strong">
          <Icon name="close" size={14} className="mt-0.5 shrink-0 text-danger" />
          {result.code === 'validation_error' ? dict.states.error : copy.liveSubmitFailed(result.code)}
        </p>
      ) : null}
    </form>
  );
}
