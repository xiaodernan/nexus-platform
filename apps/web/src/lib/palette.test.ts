import { describe, expect, it } from 'vitest';

import {
  isCloseShortcut,
  isOpenPaletteShortcut,
  isSubmitShortcut,
  isTypingTarget,
  paletteSearchPath,
  type KeyStroke,
} from './palette';

/**
 * D1056 — the Cmd/Ctrl+K palette keeps its shortcut discipline: exactly one of
 * Meta/Ctrl must be held (not both), keys pressed inside a field never open it,
 * Esc/Enter are the only in-palette keys the app listens for, and the submitted
 * query is handed to the ordinary search route, trimmed and bounded.
 */

const k = (stroke: string, extra: Partial<KeyStroke> = {}): KeyStroke => ({ key: stroke, ...extra });

describe('palette open shortcut', () => {
  it('opens on Meta+K and Ctrl+K, exactly one', () => {
    expect(isOpenPaletteShortcut(k('k', { metaKey: true }))).toBe(true);
    expect(isOpenPaletteShortcut(k('k', { ctrlKey: true }))).toBe(true);
    expect(isOpenPaletteShortcut(k('K', { metaKey: true }))).toBe(true); // case-insensitive
  });

  it('never opens on both modifiers, non-K, or no modifier', () => {
    expect(isOpenPaletteShortcut(k('k', { metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isOpenPaletteShortcut(k('x', { metaKey: true }))).toBe(false);
    expect(isOpenPaletteShortcut(k('k'))).toBe(false);
  });
});

describe('palette typing-lane guard', () => {
  const el = (tag: string, attrs: Record<string, string> = {}) =>
    ({ tagName: tag.toUpperCase(), isContentEditable: false, closest: () => null, ...attrs }) as unknown as EventTarget;

  it('never opens inside inputs/textareas/selects/editable surfaces', () => {
    for (const tag of ['input', 'textarea', 'select', 'option']) {
      expect(isTypingTarget(el(tag))).toBe(true);
    }
  });

  it('opens on document/body/plain elements', () => {
    expect(isTypingTarget(el('body'))).toBe(false);
    expect(isTypingTarget(el('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('palette submit + close', () => {
  it('Enter submits only when it means the query, Esc always closes', () => {
    expect(isSubmitShortcut(k('Enter'))).toBe(true);
    expect(isSubmitShortcut(k('Escape'))).toBe(false);
    expect(isCloseShortcut(k('Escape'))).toBe(true);
    expect(isCloseShortcut(k('Enter'))).toBe(false);
  });
});

describe('palette search path', () => {
  it('trims, bounding the query, and routes to /search', () => {
    expect(paletteSearchPath('  九龍城  太鼓   拉麵  ')).toBe('/search?q=%E4%B9%9D%E9%BE%8D%E5%9F%8E+%E5%A4%AA%E9%BC%93+%E6%8B%89%E9%BA%B5');
    expect(paletteSearchPath('')).toBe('/search?q=');
    expect(paletteSearchPath('x'.repeat(300))).toHaveLength('/search?q='.length + 200);
  });

  it('carries an explicit locale when asked', () => {
    expect(paletteSearchPath('noodles', 'zh-HK')).toBe('/search?q=noodles&locale=zh-HK');
  });
});
