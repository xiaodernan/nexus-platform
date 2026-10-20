import { cookies, headers } from 'next/headers';

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, type Locale } from './dict';

/**
 * Server-side locale resolution: an explicit cookie wins, then `Accept-Language`.
 * Nothing reads the cookie inside a client component — pages pass the resolved string down, which
 * is also why the dictionaries themselves are pure (`../i18n`, not this file).
 */
export async function currentLocale(): Promise<Locale> {
  const jar = await cookies();
  const fromCookie = jar.get(LOCALE_COOKIE)?.value;
  if (fromCookie) return normalizeLocale(fromCookie);
  const all = await headers();
  const accept = all.get('accept-language');
  const first = accept?.split(',')[0]?.trim();
  return first ? normalizeLocale(first) : DEFAULT_LOCALE;
}
