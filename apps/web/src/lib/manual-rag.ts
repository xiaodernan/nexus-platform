/**
 * `manual-rag.ts` — the RAG layer for the in-product manual (`/handbook?ask=`).
 *
 * Retrieval only, deliberately. The operator's live provider serves NO embedding model
 * (D1266 — measured 2026-11-16, 503/404 for every candidate), so the vector lane is
 * unavailable and any "AI answer" shipped today would be either impossible or fabricated —
 * both worse than the truth below:
 *
 *   - retrieval is honest and deterministic: zh sections are scored on char-bigram
 *     relevance with inverse-corpus-frequency, en sections on whole word tokens with the
 *     same weighting; top-3 sections come back with verbatim excerpts. No embeddings, no
 *     storage, no network, no LLM required. The page renders SOMETHING grounded in the
 *     manual itself, every time, offline — that is the product's promise to the reader.
 *   - there is deliberately NO model call in this path today: hand-rolled BM25-free lexical
 *     search is strictly weaker than a retrieval read but strictly better than an invented
 *     answer. Wiring an LLM into `ask=` was an operator decision reserved for when a live-model
 *     surface with a working contract exists; D1279 shipped that lane as an optional
 *     client-side phrasing pass over this module's retrieval output (see the BFF route
 *     `/api/nexus/ai/handbook-ask` and `components/handbook-ask-live.tsx`) — this module stays
 *     model-free by design, and the page always renders its deterministic answer first,
 *     with the model lane progressive on top.
 *
 * Tests exercise only this deterministic layer; the module touches no env and no network.
 */

import { getDict } from './i18n';

export interface ManualSection {
  readonly id: string;
  readonly kicker: string;
  readonly title: string;
  readonly score: number;
  readonly corpus: string;
  readonly excerpt: readonly string[];
}

export interface ManualAnswer {
  readonly degraded: true;
  readonly answer: string;
  readonly citations: ReadonlyArray<{ id: string; title: string }>;
  readonly sections: ReadonlyArray<Pick<ManualSection, 'id' | 'kicker' | 'title' | 'score' | 'excerpt'>>;
}

export interface CorpusSection {
  readonly id: string;
  readonly kicker: string;
  readonly title: string;
  readonly paragraphs?: ReadonlyArray<string>;
  readonly bullets?: ReadonlyArray<string>;
}

function sectionCorpus(section: CorpusSection): string {
  const parts = [section.title, section.kicker, ...(section.paragraphs ?? []), ...(section.bullets ?? [])];
  return parts.join(' \n ');
}

function corpus(locale: string): Array<{ id: string; kicker: string; title: string; corpus: string }> {
  const dict = getDict(locale);
  return (dict.handbook.sections as unknown as CorpusSection[] | undefined ?? []).map((section) => ({
    id: section.id,
    kicker: section.kicker,
    title: section.title,
    corpus: sectionCorpus(section),
  }));
}

/** Cheap zh tokenisation: char bigrams (plus single chars guard for one-char queries). */
function zhTokens(text: string): string[] {
  const cjk = Array.from(text.replace(/[^\u4e00-\u9fff]/g, ''));
  const bigrams: string[] = [];
  for (let i = 0; i < cjk.length - 1; i += 1) bigrams.push(cjk[i] + cjk[i + 1]!);
  if (bigrams.length === 0 && cjk.length > 0) bigrams.push(...cjk);
  return bigrams;
}

const EN_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'at', 'is', 'are',
  'with', 'as', 'by', 'i', 'you', 'what', 'how', 'this', 'that', 'it', 'be', 'not']);

function enTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z'-]{1,}/g)?.filter((t) => !EN_STOP.has(t)) ?? [];
}

function tokensFor(text: string, locale: string): string[] {
  if (locale.startsWith('zh')) return [...zhTokens(text), ...enTokens(text)];
  return enTokens(text);
}

const cache = new Map<string, Array<{ id: string; kicker: string; title: string; corpus: string }>>();

function corpusCached(locale: string): Array<{ id: string; kicker: string; title: string; corpus: string }> {
  const hit = cache.get(locale);
  if (hit) return hit;
  const built = corpus(locale);
  cache.set(locale, built);
  return built;
}

/**
 * Rank the handbook by what the question shares with each section — deterministic, offline,
 * zero network. zh scores on char-bigrams, en on whole word tokens; weights are the section's
 * inverse-corpus-frequency. Top-3, tie-broken by section id.
 */
export function retrieve(question: string, locale: string, limit = 3): ManualSection[] {
  const qTokens = tokensFor(question, locale);
  if (!question.trim() || qTokens.length === 0) return [];
  const entries = corpusCached(locale);
  const N = entries.length || 1;
  const df = new Map<string, number>();
  for (const entry of entries) {
    const seen = new Set(tokensFor(entry.corpus, locale));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const qCount = new Map<string, number>();
  for (const t of qTokens) qCount.set(t, (qCount.get(t) ?? 0) + 1);

  const scored = entries.map((entry) => {
    const tokenCounts = new Map<string, number>();
    for (const t of tokensFor(entry.corpus, locale)) {
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }
    let score = 0;
    for (const [term, qf] of qCount) {
      const f = tokenCounts.get(term) ?? 0;
      if (f === 0) continue;
      const idf = Math.log((N + 1) / ((df.get(term) ?? 0) + 1)) + 1;
      score += idf * (qf * (1 + Math.log(f))) / (1 + Math.log(qTokens.length));
    }
    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return scored.slice(0, limit).filter((r) => r.score > 0).map((r) => ({
    id: r.entry.id,
    kicker: r.entry.kicker,
    title: r.entry.title,
    score: Number(r.score.toFixed(4)),
    corpus: r.entry.corpus,
    excerpt: ((getDict(locale).handbook.sections as unknown as CorpusSection[] | undefined) ?? [])
      .find((section) => section.id === r.entry.id)?.paragraphs ?? [],
  }));
}

/** Grounded "answer": quote the top retrieval section verbatim; always degraded, never fabricated. */
export function answerManual(question: string, locale: string): ManualAnswer {
  const trimmed = question.trim();
  if (!trimmed) {
    return { degraded: true, answer: '', citations: [], sections: [] };
  }
  const sections = retrieve(trimmed, locale, 3);
  const top = sections[0];
  const isZhCN = locale.toLowerCase().startsWith('zh-cn') || locale.toLowerCase().startsWith('zh-hans') || locale.toLowerCase().startsWith('zh-sg');
  const isZh = locale.startsWith('zh');
  if (!top) {
    return {
      degraded: true,
      answer: isZh
        ? isZhCN
          ? '找不到对应的章节——试试输入「拉面」、「漫画」、「预算」或「错误」之类的词。'
          : '找不到對應的章節——試試輸入「拉麵」、「漫畫」、「預算」或「錯誤」之類的詞。'
        : 'No matching section — try simple nouns like “ramen”, “saving”, “budget”.',
      citations: [],
      sections: [],
    };
  }
  const quote = [top.excerpt[0], top.excerpt[1]].filter(Boolean).join(' ');
  const answer = quote.length > 0
    ? (isZh ? `看「${top.title}」：${quote}` : `Read “${top.title}”: ${quote}`)
    : (isZh
        ? isZhCN
          ? `看「${top.title}」——里面详细讲了你要的事。`
          : `看「${top.title}」——裡面詳細講了你要的事。`
        : `Read “${top.title}” — it covers what you asked.`);
  return {
    degraded: true,
    answer,
    citations: sections.map((s) => ({ id: s.id, title: s.title })),
    sections,
  };
}

/** Shape of one rendered excerpt row — used by the handbook page and the pin tests. */
export function formatExcerpt(section: Pick<ManualSection, 'excerpt'>, maxLength = 140): string[] {
  return section.excerpt.map((line) => (line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line));
}
