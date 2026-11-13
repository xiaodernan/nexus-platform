/**
 * Pure helpers for the global command palette. Kept free of React so the
 * palette's behaviour is fully testable without a renderer (the repo has no DOM
 * test harness by design — see docs/README for the discipline).
 *
 * The palette opens on Meta+K (macOS) or Ctrl+K (Windows/Linux), closes on Escape,
 * and submits an ordinary search. It deliberately does NOT hijack keys while the
 * reader is already typing in a field — a shortcut that fires inside a conversation
 * would be hostile to both.
 */

export interface KeyStroke {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

/** Tags in which bare keys must never be hijacked by the global palette. */
const TYPING_TAGS: ReadonlySet<string> = new Set(['input', 'textarea', 'select', 'option']);

/** True when the event target is a field that is currently receiving keystrokes. Duck-typed so it runs in any DOM-like environment. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement | undefined;
  if (!el || typeof el.tagName !== 'string') return false;
  if (TYPING_TAGS.has(el.tagName.toLowerCase())) return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) return true;
  return false;
}

/** Cmd+K or Ctrl+K opens; any extra modifier is not ours (e.g. Cmd+Shift+K). */
export function isOpenPaletteShortcut(event: KeyStroke): boolean {
  if (event.key.toLowerCase() !== 'k') return false;
  const primary = Boolean(event.metaKey) !== Boolean(event.ctrlKey); // exactly one
  if (!primary) return false;
  return true;
}

export function isCloseShortcut(event: KeyStroke): boolean {
  return event.key === 'Escape';
}

export function isSubmitShortcut(event: KeyStroke): boolean {
  return event.key === 'Enter';
}

/** The ordinary search route the palette submits to — trimming and bounding the query. */
export function paletteSearchPath(query: string, locale?: string): string {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 200);
  const params = new URLSearchParams();
  params.set('q', q);
  if (locale) params.set('locale', locale);
  return `/search?${params.toString()}`;
}
