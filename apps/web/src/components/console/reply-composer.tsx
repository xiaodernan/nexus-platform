'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@nexus/ui';
import { getDict } from '@/lib/i18n';

/**
 * The merchant team's voice in the conversation (§142's return half). One textarea, one button —
 * it posts to `POST /api/nexus/conversations/{id}/reply`, which forwards to the platform's
 * `send_message`-RBAC-gated internal door and gets the caller in as themselves. The reply lands
 * in the same thread the AI agent answered in; `router.refresh()` re-reads it so the new turn is
 * visible on the spot, labelled `merchant_user` rather than `ai_agent`.
 *
 * Demo/mock origin threads never render this (the parent page suppresses it) — a reply the
 * merchant believes was sent must never vanish.
 */
export function ReplyComposer({
  conversationId,
  locale,
}: {
  conversationId: string;
  locale: string;
}) {
  const dict = getDict(locale);
  const copy = dict.console.conversations;
  const router = useRouter();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    const content = text.trim();
    if (!content || pending) return;
    setPending(true);
    setFailed(null);
    try {
      const response = await fetch(`/api/nexus/conversations/${encodeURIComponent(conversationId)}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as
          | { error?: { code?: string } }
          | null;
        setFailed(envelope?.error?.code ?? String(response.status));
        return;
      }
      setText('');
      router.refresh();
    } catch {
      setFailed('upstream_unreachable');
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="merchant-reply" className="text-xs font-medium text-ink-faint">
        {copy.replyLabel}
      </label>
      {/* Same focus-visible ring the design system's `field-classes.ts` gives every field control:
          a bare `outline-none` erased the keyboard focus indicator here (console a11y gate). */}
      <textarea
        id="merchant-reply"
        rows={2}
        maxLength={2000}
        value={text}
        disabled={pending}
        placeholder={copy.replyPlaceholder}
        onChange={(event) => setText(event.target.value)}
        className="w-full resize-y rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-strong outline-none placeholder:text-ink-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/35"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-2xs leading-relaxed text-ink-muted">{copy.replyHint}</p>
        <Button type="submit" variant="primary" size="sm" shape="md" disabled={pending || !text.trim()}>
          {pending ? copy.replySubmitting : copy.replySubmit}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-2xs text-danger">
          {copy.replyFailed(failed)}
        </p>
      ) : null}
    </form>
  );
}
