'use client';

/**
 * "Mark the whole inbox read" for the consumer hub (D1076). The door is the documented §123
 * `POST /api/v1/notifications/read-all`, reached through the BFF (`/api/nexus/platform/...`), so
 * the session cookie and tenant header attach server-side and the browser never sees a service
 * origin. Idempotent: a second press marks zero more rows and still answers 200.
 *
 * In demo mode the BFF answers `data_mode_mock` (501) and this island says so plainly instead of
 * pretending the fixture rows changed — the fixture catalogue is deterministic and would render the
 * same unread states on refresh.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@nexus/ui';

export function MeReadAll({
  label,
  doneLabel,
  busyLabel,
}: {
  label: string;
  doneLabel: string;
  busyLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [marked, setMarked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function markAll() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/nexus/platform/notifications/read-all', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      });
      const payload = (await response.json().catch(() => null)) as
        | { marked_read?: number }
        | { error?: { code?: string } }
        | null;
      if (!response.ok) {
        const code = (payload as { error?: { code?: string } } | null)?.error?.code ?? String(response.status);
        setError(code);
        setMarked(null);
        return;
      }
      const count = (payload as { marked_read?: number } | null)?.marked_read;
      setMarked(typeof count === 'number' ? count : null);
      router.refresh();
    } catch {
      setError('upstream_unreachable');
      setMarked(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={markAll}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-2xs font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
      >
        <Icon name={busy ? 'spinner' : 'check'} size={12} />
        {busy ? busyLabel : marked !== null ? doneLabel : label}
      </button>
      {error ? <span className="font-mono text-2xs text-ink-faint">{error}</span> : null}
    </span>
  );
}
