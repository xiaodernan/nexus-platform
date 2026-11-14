'use client';

/**
 * 今日日期 — the /daily page's calendar line. HK-local date, client-side, zero fetch.
 *
 * Renders `2026.11.15` big plus the weekday name in the current locale; computed after mount so
 * SSR output can never disagree with the reader's wall clock. No state, no fetch, no telemetry.
 */

import { useEffect, useState } from 'react';

import { hkDateKey } from '@/lib/almanac';

export function HkDailyDate({ weekdays, separator }: { weekdays: readonly string[]; separator: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
  }, []);

  const [dateKey, weekday] = (() => {
    if (now === null) return ['——', ''];
    const key = hkDateKey(now);
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Hong_Kong' }).format(now);
    return [key.replaceAll('-', separator), weekdays[['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(wd)] ?? wd];
  })();

  return (
    <p className="text-2xs font-semibold uppercase tracking-[0.3em] text-accent">
      <span className="mr-3 inline-block">{dateKey}</span>
      <span className="text-ink-faint">{weekday}</span>
    </p>
  );
}
