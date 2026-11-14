'use client';

/**
 * The /me favorites grid with the door §3 already opened: `DELETE /api/v1/me/favorites/{type}/{id}`.
 * A tap on the heart action unsaves the merchant; the cards are the same `EntityCardView` the rest
 * of the product renders through (same trust rules) — the only addition is a per-card `favorite`
 * action wired to the BFF delete, then router.refresh() so the server re-reads the list.
 *
 * In demo mode the BFF answers 501 `data_mode_mock` and the island says so instead of pretending
 * the fixture row changed — the envelope code prints verbatim.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EntityCardView, Icon } from '@nexus/ui';
import type { EntityCard as EntityCardModel } from '@nexus/ui/trust/types';
import { trustLabels } from '@/lib/i18n';

export interface UnsavableCardRow {
  /** Stable key for the grid order — the *favorite* row id from the platform. */
  favoriteId: string;
  subjectType: string;
  subjectId: string;
  card: EntityCardModel;
}

export function MeFavoritesGrid({
  rows,
  locale,
  labels,
  className,
}: {
  rows: UnsavableCardRow[];
  locale: string;
  labels: { unsave: string; unsaveBusy: string; unsaveDone: string; unsaveFailed: string };
  className?: string;
}) {
  const router = useRouter();
  const trust = trustLabels(locale);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = rows.filter((row) => !removed.has(row.favoriteId));

  async function unsave(row: UnsavableCardRow) {
    setBusy(row.favoriteId);
    setError(null);
    try {
      const response = await fetch(
        `/api/nexus/platform/me/favorites/${encodeURIComponent(row.subjectType)}/${encodeURIComponent(row.subjectId)}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        setError(body?.error?.code ?? String(response.status));
        return;
      }
      setRemoved((current) => new Set(current).add(row.favoriteId));
      router.refresh();
    } catch {
      setError('upstream_unreachable');
    } finally {
      setBusy(null);
    }
  }

  if (visible.length === 0) {
    return (
      <p role="status" className="mt-3 inline-flex items-center gap-1.5 text-xs text-ink-faint">
        <Icon name="check" size={12} />
        {labels.unsaveDone}
      </p>
    );
  }

  return (
    <div className={className}>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((row, index) => (
          <li key={row.favoriteId} className="flex">
            <EntityCardView
              card={{
                ...row.card,
                actions: [
                  { type: 'favorite', label: busy === row.favoriteId ? labels.unsaveBusy : labels.unsave },
                ],
              }}
              labels={trust}
              variant="grid"
              rank={index + 1}
              showAvailability
              className="w-full"
              onAction={() => unsave(row)}
            />
          </li>
        ))}
      </ul>
      {error ? (
        <p role="status" className="mt-2 font-mono text-2xs text-warning">
          {labels.unsaveFailed}: {error}
        </p>
      ) : null}
    </div>
  );
}
