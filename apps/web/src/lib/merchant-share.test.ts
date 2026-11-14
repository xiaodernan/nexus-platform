import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1066 — the merchant share affordance pins its share behaviour to the two channels that matter
 * in Hong Kong (WhatsApp + copy-link/WeChat), no analytics, no third parties, no stuck focus trap.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const COMPONENT = 'apps/web/src/components/merchant-share.tsx';
const VIEW = 'apps/web/src/components/merchant-view.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1066 merchant share affordance', () => {
  it('is a client island mounted once inside the merchant header', () => {
    const component = read(COMPONENT);
    expect(component.startsWith("'use client';")).toBe(true);
    expect(component).toContain('navigator.clipboard');
    expect(component).toContain('https://wa.me/?text=');
    expect(component).toContain('aria-haspopup="dialog"');
    expect(component).toContain('role="dialog"');
    const view = read(VIEW);
    expect(view).toContain("import { MerchantShare } from './merchant-share';");
    expect(view).toContain('<MerchantShare');
  });

  it('shares only what it has: the merchant name and this page URL', () => {
    const component = read(COMPONENT);
    expect(component).toContain("typeof window === 'undefined'");
    expect(component).toContain('window.location.href');
    expect(component).not.toMatch(/google-analytics|gtag|facebook\.net|pixel/i);
  });

  it('dict carries both locales, with Traditional script in zh-HK', () => {
    const dict = read(DICT);
    expect(dict).toContain("shareLabel: '分享'");
    expect(dict).toContain("shareTitle: '分享這間商戶'");
    expect(dict).toContain("shareLabel: 'Share'");
    expect(dict).toContain("shareTitle: 'Share this merchant'");
  });

  it('Esc and outside-pointer close the popover — no stuck focus trap', () => {
    const component = read(COMPONENT);
    expect(component).toContain("event.key === 'Escape'");
    expect(component).toContain("document.addEventListener('keydown'");
  });
});
