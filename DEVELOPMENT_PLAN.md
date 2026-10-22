# NEXUS Platform — Continuous Development Plan

## Vision
AI-native commerce & local discovery platform. Consumers express needs in natural language; NEXUS understands, searches, compares and recommends. Merchants get an AI business agent for discovery, customer service, marketing, SEO and analytics on their data.

## Current Phase: MVP Vertical Slice (Phase 1)
**First market**: Hong Kong  
**Architecture target**: Global-ready  
**Status**: Active construction — contracts are the source of truth

---

## 📋 QUARTERLY ROADMAP

### Q1: Foundation & MVP Completion
- [ ] Hybrid search with pgvector + pgtrgm + CJK support (D32/CJK text-search)
- [ ] Agent run ledger with persistence (D440: stamp_run, finished_at tracking)
- [ ] Database schema finalize & migrate to V10
- [ ] MVP consumer flow: "帮我找一个适合情侣约会的地方" → intent → search → ranking → merchant page → AI answers → lead/reservation
- [ ] LLM fallback chain: model failure → deterministic search → human handoff

### Q2: Scale & Robustness
- [ ] CJK text-search config (replace `tsvector('simple')` with appropriate parser)
- [ ] Row-level security (RLS) policies on tenant-scoped tables
- [ ] Recommendation sets → facts FK-checked join table
- [ ] Availability exclusion constraint (btree_gist on slots)
- [ ] Model swap architecture (embedding dim migration path)

### Q3: Multi-Tenancy & Global
- [ ] Multi-tenant data isolation patterns
- [ ] Global expansion beyond Hong Kong (SG, TW, MO markets)
- [ ] Payment provider integration (beyond demo)
- [ ] Real LLM provider integration (Anthropic/OpenAI)

### Q4: Platform Maturity
- [ ] Full Docker containerization
- [ ] CI/CD pipelines
- [ ] Observability (tracing, metrics, logs)
- [ ] Agent trust layer & permission grants
- [ ] MCP/UCP full integration

---

## 🛠️ WEEKLY DEVELOPMENT CADENCE

### Monday: Plan & Review
- [] Review open issues & PRs
- [] Plan weekly sprint goals from roadmap
- [] Sync on contracts (API_CONTRACT.md, AGENT_CONTRACT.md)

### Tuesday-Thursday: Feature Development
- **AI/Search track**: `apps/ai/nexus_ai/search/` — hybrid ranking, CJK matching, vector search
- **API track**: `apps/ai/nexus_ai/api/` — run ledger, conversation timeline, event persistence
- **Platform track**: `services/platform/` — Spring Boot features, commerce core, payments
- **Frontend track**: `apps/web/` — Next.js pages, BFF, UI components

### Friday: Test & Integrate
- [ ] Run unit tests: `pytest -q -m "not integration"` (apps/ai)
- [ ] TypeCheck: `tsc --noEmit` (apps/web)
- [ ] Lint: `eslint .` and `ruff check .`
- [ ] Git commit with descriptive message
- [ ] `git push origin master`
- [ ] Demo working increment

---

## 📌 CONTRACT GUIDELINES (Always reference before coding)

### API Contract (`docs/API_CONTRACT.md`)
- Every endpoint must have `EntityCard`/`Fact`/`Intent` shapes documented
- No breaking changes without version bump
- Marketing/SEO output generated as drafts; publishing requires explicit human action

### Agent Contract (`docs/AGENT_CONTRACT.md`)
- Agents act through tool registry with explicit permission grants
- Never directly against database
- Never with self-escalated scope
- Ranking with verifiable explanations
- RAG → ranking with citations → merchant AI answers from knowledge base

### Data Model (`infra/db/migrations/V*.sql`)
- Every price, rating, hour and distance traces to a `facts` row with `source`, `confidence`, `observed_at`, `expires_at`
- Unverifiable = rendered as unverified
- Synthetic demo data labeled demo. Fake reviews/merchants/prices/traffic prohibited
- Organic ranking never reads spend. Sponsored entries inserted after organic scoring and labelled

---

## 🚫 NON-NEGOTIABLE PRODUCT RULES

1. **Real data or nothing**: Every price, rating, hour, distance traces to a `facts` row
2. **Synthetic demo data labeled**: Fake reviews, merchants, prices, traffic prohibited
3. **Organic ranking never reads spend**: Sponsored entries inserted after organic scoring, labelled
4. **AI agents through tool registry only**: No direct DB access, no self-escalated scope
5. **Marketing/SEO output as drafts**: Publishing requires explicit human action
6. **Model failure fallback**: model → deterministic search → human handoff. Site never goes dark because LLM failed

---

## 📊 LAST COMMIT SUMMARY

```
feat: AI search pipeline and run ledger enhancements
- Hybrid search SQL with pgvector, pgtrigon, haversine geo-query
- Agent run stamping (started_at/finished_at consistency)
- Database documentation update (DATABASE.md)
- New test files for filter vocabulary and UUID bindings
- Migration V10: facts subject_id index
- E2E test reports captured
```

**Pushed to**: `git@github.com:xiaodernan/nexus-platform.git` → `master`

---

## � NEXT IMMEDIATE ACTIONS

1. **Run the new test suite**: `cd apps/ai && uv run pytest -q` or `python -m pytest -q`
2. **Verify type checking**: `cd apps/web && npx tsc --noEmit`
3. **Check linting**: `cd apps/web && npm run lint` and `cd apps/ai && uv run ruff check .`
4. **Review DATABASE.md updates** against actual migrations
5. **Plan next week's sprint** from the quarterly roadmap

---

## 📅 ONGOING COMMIT PROTOCOL

Every development session must end with:
1. `git add -A` (stage all changes)
2. `git commit -m "feat/fix/refactor: <descriptive summary of changes>"`
3. `git push origin master`
4. Update `docs/DEVLOG.md` or `platform-dev.log` with session summary

**Never stop** — each commit builds toward the MVP vertical slice and beyond. Absolute continuity is the goal.