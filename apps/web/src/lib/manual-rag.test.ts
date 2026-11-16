import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * D1269 — pins for the in-product manual RAG seam: retrieval is deterministic, offline,
 * and grounded in the shipped handbook corpus. No network, no embeddings, no model.
 * /handbook?ask= renders the excerpt with section-id citations.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const RAG = 'apps/web/src/lib/manual-rag.ts';
const PAGE = 'apps/web/app/handbook/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1269 the handbook asks back', () => {
  it('retrieval is deterministic, scored, and zh corpus with English keywords works', async () => {
    const { retrieve } = await import('@/lib/manual-rag');
    const r1 = retrieve('滑鼠滾輪', 'zh-HK', 3);
    const r2 = retrieve('滑鼠滾輪', 'zh-HK', 3);
    expect(r1).toEqual(r2);
    expect(r1.length).toBeGreaterThan(0);
    expect(r1[0]!.score).toBeGreaterThan(0);

    const en = retrieve('mouse wheel reversed', 'en', 3);
    expect(en.length).toBeGreaterThan(0);

    // determinism of ordering beyond score ties is by id — no random shuffle ever
    expect([...r1].every((r, i, arr) => i === 0 || (arr[i - 1]!.score >= r.score))).toBe(true);

    // a pure gibberish query gets the no-match branch, not an invented excerpt
    const zzz = retrieve('zzzqqq', 'zh-HK', 3);
    expect(zzz.length).toBe(0);
  });

  it('answerManual is grounded in the shipped corpus and carries real section ids', async () => {
    const { answerManual } = await import('@/lib/manual-rag');
    const dict = read(DICT);
    for (const locale of ['zh-HK', 'en']) {
      const answer = answerManual(locale === 'zh-HK' ? '滑鼠滾輪是不是反了' : 'is my mouse wheel reversed', locale);
      expect(answer.degraded).toBe(true);
      expect(answer.citations.length).toBeGreaterThan(0);
      for (const c of answer.citations) {
        expect(dict.includes(`id: '${c.id}'`)).toBe(true);
      }
      expect(answer.answer.length).toBeGreaterThan(20);
    }
  });

  it('the handbook page renders the ask form and the answer block with section citations', () => {
    const page = read(PAGE);
    expect(page).toContain("answerManual(askQ, locale)");
    expect(page).toContain('askManual.eyebrow');
    expect(page).toContain('name="ask"');
    expect(page).toContain('askAnswer.citations.map');
    expect(page).toContain('askManual.degradedNote');
    expect(page).toContain('askManual.title');
    expect(page).toContain("export default async function HandbookPage(props: {");
  });

  it('both locales carry the ask UI in full', () => {
    const dict = read(DICT);
    for (const key of ['askManual: {', 'eyebrow:', 'title:', 'placeholder:', 'submit:', 'degradedNote:', 'noMatch:']) {
      const hits = (dict.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      expect(hits).toBeGreaterThanOrEqual(2);
    }
    expect(dict).toContain('問手冊 · 不需要 AI');
    expect(dict).toContain('ASK THE MANUAL · NO AI');
  });

  it('the retrieval module touches no env, no network, no model', () => {
    const rag = read(RAG);
    expect(rag).not.toContain('process.env');
    expect(rag).not.toContain('fetch(');
    expect(rag).not.toContain('http');
    expect(rag).not.toContain('openai');
    expect(rag).toContain('retrieve(');
    expect(rag).toContain('answerManual');
  });
});
