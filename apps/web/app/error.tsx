'use client';

import { Button, Container, Icon } from '@nexus/ui';

import { DEFAULT_LOCALE } from '@/lib/env';
import { getDict } from '@/lib/i18n';

/**
 * Route-level failure boundary. Like the 404 it cannot read request state, so it uses the default
 * locale; the message shown is the real one from the failed render, and the request id is surfaced
 * when the envelope carried one (§1 error contract).
 */
export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const dict = getDict(DEFAULT_LOCALE);
  return (
    <Container size="shell" className="flex flex-col items-start gap-4 py-16 sm:py-24">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-strong sm:text-3xl">{dict.states.error}</h1>
      <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{dict.merchant.degradedTitle}</p>
      <p className="flex max-w-prose items-start gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-muted">
        <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-warning" />
        <span className="break-all">{error.message || dict.states.error}</span>
      </p>
      {error.digest ? <p className="font-mono text-2xs text-ink-faint">digest {error.digest}</p> : null}
      <Button variant="outline" size="md" onClick={reset} leadingIcon={<Icon name="refresh" size={15} />}>
        {dict.search.retry}
      </Button>
    </Container>
  );
}
