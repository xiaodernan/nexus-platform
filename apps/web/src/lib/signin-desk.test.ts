import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1077 — the sign-in desk pins its two-panel composition:
 *   - the left promise panel renders `dict.brand.tagline` as the display headline, maps
 *     `dict.signin.proofs` (three HK-local points) — never hand-written copy;
 *   - both locales carry the proofs (zh-HK Traditional script markers present);
 *   - the right card still owns the working action (`SignInActions`) and the §46/§48 refusal renders
 *     whatever the live door says — the panel upgrade does not touch that contract.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/signin/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1077 sign-in desk', () => {
  it('is a server component with the two-panel composition', () => {
    const page = read(PAGE);
    expect(page).not.toContain("'use client'");
    expect(page).toContain('dict.signin.proofs.map');
    expect(page).toContain('dict.brand.tagline');
    expect(page).toContain('<SignInActions locale={locale} />');
    expect(page).toContain('dict.home.sourceNote');
  });

  it('the dict carries the proofs in both locales with HK Traditional script in zh', () => {
    const dict = read(DICT);
    expect(dict).toContain("proofsTitle: '為什麼是香港本地'");
    expect(dict).toContain("proofsTitle: 'Why Hong Kong first'");
    expect(dict).toContain('每個數字都有出處');
    expect(dict).toContain('幫我搵邊間好食啲');
  });
});
