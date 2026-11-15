/**
 * D1178 — the pure date-slot picker shared by the server-rendered home page and the
 * `HkTodaySlotCard` client island. Kept free of React and 'use client' so server components
 * can compute today's slot without importing a client module.
 */

export interface HkTodaySlot {
  /** /guides/<slug> */
  href: string;
  /** e.g. 第五十章 / Chapter 50 */
  roman: string;
  /** e.g. 中午十二點四十五分：佐敦吉華餃麵店 */
  label: string;
}

export function pickTodaySlot(slots: readonly HkTodaySlot[], dateKey: string): HkTodaySlot | null {
  if (slots.length === 0) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return slots[h % slots.length] ?? null;
}
