'use client';

import { DemoBadge } from '@nexus/ui';
import { trustLabels } from '@/lib/i18n';

/**
 * `DemoBadge` is a client component and `TrustLabels` holds functions, so the labels cannot be built
 * on the server and passed down — the boundary rejects a function prop. This wrapper takes the
 * locale (a string crosses freely) and resolves the labels on this side, which is the only way a
 * Server Component can render the §155 demo marker.
 */
export function LocaleDemoBadge({ locale, className }: { locale: string; className?: string }) {
  return <DemoBadge labels={trustLabels(locale)} className={className} />;
}
