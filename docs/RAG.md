# NEXUS — RAG System (§12)

Status: **to be built.** Owner: `apps/ai/nexus_ai/rag/**`, DB role `nexus_ai` (read-write on `documents, chunks, facts`).
Shapes/thresholds reference [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §7 (pipeline) and §4 (trust). Query/agent wiring:
[AI.md](AI.md), [AGENTS.md](AGENTS.md). Embedding dim is **fixed at 1024** (D3) — a model change is a migration, not config.

## 1. Knowledge sources (§12)
Merchant information, products, menus, services, FAQs, policies, reviews, documents, image metadata, business
descriptions, user preferences — all land in `documents` (parsed `raw_text` + `content_hash`) and are chunked into
`chunks` with `embedding vector(1024)` + `search_tsv`.

## 2. Pipeline (§12, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §7)
```
documents → parse → clean → semantic chunk → embed → store → hybrid retrieve → rerank → context pack → LLM
```
Concrete parameters (implement exactly, they are the tuned defaults):

| Stage | Module | Decision |
|---|---|---|
| Parse | `ingest.py` | per-kind extractor (menu/pdf/xlsx/url/image-OCR); OCR/URL output is untrusted (§51) |
| Clean | `ingest.py` | strip boilerplate, normalise whitespace/encoding, dedupe by `content_hash` |
| Chunk | `chunk.py` | **semantic, 240–400 tokens, 12% overlap, section-aware** (`section` column carries the heading) |
| Embed | `embed.py` | embedding model, dim 1024, **batched**, cached by content hash; sets `embed_model`, `embedded_at` |
| Store | `embed.py` | `chunks.embedding` (HNSW cosine) + `search_tsv` (trigger, [DATABASE.md](DATABASE.md) §8) + trgm |
| Retrieve | `apps/ai/nexus_ai/search/sql.py` | **tsvector ∪ pgvector cosine**, filtered by `tenant_id` (+`merchant_id` on merchant path) **before** ranking |
| Rerank | `apps/ai/nexus_ai/models/router.py` | cross-encoder or LLM listwise on **top-40 only** ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §9) |
| Pack | `apps/ai/nexus_ai/api/routes_rag.py` | dedupe, build a context pack carrying `document_id, chunk_id, source_uri, fact_ids` for citation |
| Generate | (LLM via router) | answer must cite the pack; **no answer without retrieval** |

Ownership of retrieval filter: the tenant filter runs *before* similarity scoring (chunks denormalise `merchant_id`/
`tenant_id` precisely for this, [DATABASE.md](DATABASE.md) §3.7); a `retrieval` agent that mixes tenants is forbidden
([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1).

## 3. Endpoint surface
- `POST /ai/v1/rag/retrieve {query, merchant_id?, filters, top_k}` →
  `{chunks:[{id, text, score, document_id, source_uri, fact_ids}]}` ([`API_CONTRACT.md`](API_CONTRACT.md) §7).
- Used by the merchant sales/customer-service agent (`/ai/v1/merchant-agent/chat`) grounded **only** in that merchant's
  KB ([MERCHANT.md](MERCHANT.md), [AGENTS.md](AGENTS.md)).

## 4. Trust integration (§19)
Every chunk keeps `document_id`/`source_uri` so an answer's claims resolve to a `facts` row. The generator's numeric/
entity claims are matched back to retrieved facts; unmatched claims are stripped and counted in `hallucination_rate`
(the top CI gate, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4/§11). If top rerank score < threshold → the agent says it
does not know and offers handoff (§26); never upgrade confidence for presentation.

## 5. Freshness & index maintenance (§20)
KB/doc TTL is 7d, recompute on reindex ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §5). Editing a merchant document
enqueues reindex of **that document's chunks only** (targeted, not full rebuild) — `POST /api/v1/merchant/knowledge-
base/reindex`. Ingest must be an **async worker**, never inline on a request path, to protect latency budgets
([AI.md](AI.md) §4).

## 6. Prompt-injection envelope (§51, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §7/§8)
Chunk text is **untrusted content**: it is wrapped in a fixed data-delimiter envelope before reaching the LLM;
instruction-like text inside it is ignored and logged as a `prompt_injection` signal. Tool names may only come from the
registry, never from retrieved text ([AGENTS.md](AGENTS.md) §5). This is enforced in `apps/ai/nexus_ai/api/routes_rag.py` (the scan) and in the
generation step, and is a
required test in `safety_injection_v1`.

## 7. Evaluation
`rag_faithfulness_v1` (answer grounded in retrieved context, citations resolve), plus `search_relevance_v1` for
retrieval precision. Gate: hallucination < 2%, injection containment 100% ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §11,
[AI.md](AI.md) §6).

## Open questions / risks
- **CJK chunking/tokenisation:** `search_tsv('simple')` doesn't segment Chinese well ([DATABASE.md](DATABASE.md) §5);
  embedding quality for zh-HK under `mock` is untested — the real embedder must be validated before trusting semantic recall.
- **Chunk-size defaults** (240–400/12%) are unvalidated against this corpus; recheck after first real imports (M3).
- **Reranker availability:** a cross-encoder may not be reachable under `NEXUS_LLM_PROVIDER=mock`; define the mock's
  deterministic rerank so the pipeline still runs offline (D4).
- **Multi-tenant index growth:** single `chunks` table + one HNSW index is a known scale ceiling ([ARCHITECTURE.md](ARCHITECTURE.md) §9);
  partition plan deferred.
