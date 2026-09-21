# NEXUS — Security (§47–§53, §106, §127–§128, §131)

Status: **to be built.** Security is a cross-cutting contract; enforcement mechanisms already implied by
[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §3/§8, [`API_CONTRACT.md`](API_CONTRACT.md) §1, and [DATABASE.md](DATABASE.md) §9.
This doc assembles the checklist §50 demands and names the owner for each control.

## 1. AuthN / AuthZ
- **Authentication (§50):** stateless JWT (HS256 dev via `NEXUS_JWT_SECRET`, RS256 prod) + `HttpOnly` `nexus_session`
  cookie set by platform, read by Next via RSC ([D5](DECISIONS.md)). Claims `sub, tid, typ, sid, jti, iat, exp`; access
  15m, refresh 30d **rotating with reuse detection** ([`API_CONTRACT.md`](API_CONTRACT.md) §3). OAuth (google/apple)
  verified against provider JWKS; `user_identities.secret_ref` is a pointer, never a token ([DATABASE.md](DATABASE.md) §3.1).
  Passwords **Argon2id**.
- **Authorization / RBAC (§48, §49):** `permission_grants` per subject (`user|merchant_user|agent|api_key`), scoped to
  merchant or tenant; roles Owner/Admin/Manager/Staff/Marketing/Analyst/**AI Agent**. The AI agent gets a default
  read-only set; `refund_payment`/`publish_campaign` are never default-granted; grants expire; denials →
  `audit_logs(action='permission_denied')` ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §8).
- **Tenancy isolation (§47, D5):** every tenant-owned table has `tenant_id`; repositories take `TenantContext` first and
  add the predicate (a query without it fails review); cross-tenant read → **404, not 403** (no enumeration). Enforced in
  code today — **no RLS yet** (see risks).
- **Admin (§68):** admin routes require `role IN (platform_admin, platform_ops)` and write `audit_logs`.

## 2. Web & platform hardening (§50)
- **Rate limiting:** `429` + `Retry-After` + `X-RateLimit-Remaining`; state in `rate_limit_buckets` (principal+scope).
  Protect `/ai/*` (LLM cost), auth, and `/ai/v1/feedback` (ranking gaming, [RECOMMENDATION.md](RECOMMENDATION.md) risks).
- **Input validation:** schema-constrained everywhere; `additionalProperties=false` on tool schemas
  ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §3); `validation_error=422`.
- **SQL injection:** parameterised/JPA only; **no string SQL**; the role split makes `LLM→DB` physically impossible
  (§52, [DATABASE.md](DATABASE.md) §9).
- **XSS:** escape-by-default in React; sanitized rich text; CSP; untrusted AI/merchant content rendered as data.
- **CSRF:** `X-CSRF-Token` required on state-changing cookie requests ([`API_CONTRACT.md`](API_CONTRACT.md) §1).
- **SSRF:** `search_web` is the sole egress tool — allow-listed hosts, DNS-rebind guarded, 10s cap, response untrusted
  (`source=third_party`, lower confidence) ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §3). AI import of URLs uses the same
  egress controls (§22).
- **Secrets (§131):** `.env.example` committed; **never** commit API keys/passwords/tokens/credentials; `secret_ref`
  indirection; D4 real-provider keys via `NEXUS_LLM_*` only.
- **Audit logs (§50, §69):** append-only trail (actor, action, subject, before/after, ip inet) for auth, data changes,
  publish, refund, tool calls, denials.

## 3. AI-specific security — prompt injection & tool authorization (§51–§52)
Detailed in [AGENTS.md](AGENTS.md) §5; controls:
1. All external content (merchant descriptions, reviews, web pages, documents, product descriptions, image OCR, user
   messages, external-agent payloads) is **untrusted** (§51) — wrapped in a fixed data delimiter; the system prompt is
   the only instruction source.
2. **Tool names come only from the registry**, never from content; a model cannot raise its own permission scope.
3. Every tool call flows `user → agent → permission check → argument validation → tool → result validation` via
   `registry.dispatch`; never `LLM → database` (§52).
4. Injection inside retrieved chunks is ignored + logged as a `prompt_injection` signal ([RAG.md](RAG.md) §6).
5. Release gate: `safety_injection_v1` **containment = 100%** blocks the merge ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §11).

## 4. Trust & fraud (§53, §127)
Merchant verification (`ownership_verified`, `trust_signals kind=verified_business`), review moderation (fake-review
detection), suspicious-behaviour detection, transaction anomaly detection → `trust_signals` + `moderation_cases`. AI
recommendation must not fully trust merchant-provided claims (§53): `fraud_trust` guards merchant content before it
influences ranking ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1). Auto-moderation may `none|hide|flag|reject`, but
**high-risk decisions keep a human-review path** (§127); nothing auto-deletes without audit.

## 5. Privacy & payment data (§42, §106)
- Consumer data encrypted where appropriate, access-controlled, deletable, auditable; export/delete/reset rights wired
  to `deletion_requests` ([CONSUMER.md](CONSUMER.md) §9).
- **No card data stored, ever** (§42, D5): `payments` keeps `provider_ref`/`client_secret_ref` pointers only; PCI-aware;
  refunds require `refund_payment` grant + `approved_by`.

## 6. Legal / compliance config (§128)
Per-`tenant` `config jsonb` holds jurisdiction switches (payments, privacy, consumer protection, advertising, reviews,
AI disclosure, §128) — do not assume cross-country rules match; bars for regulated verticals (bars/entertainment "where
legally appropriate", §5; healthcare §5) are data-driven, not hardcoded.

## Open questions / risks
- **No Postgres RLS** — tenancy & isolation are 100% application-discipline; a single missed predicate is a cross-tenant
  leak. Recommend a `V2` RLS pass as defence-in-depth before real merchant data ([DATABASE.md](DATABASE.md) §2, §9).
- **Roles/grants unprovisioned** — `nexus_app`/`nexus_ai` split isn't enforced until `CREATE ROLE`/`GRANT` exist
  ([DATABASE.md](DATABASE.md) §9 gap).
- **JWT in dev is HS256 shared-secret** — fine locally, must be RS256 + JWKS rotation before prod; cookie + bearer dual
  mode widens CSRF/XSS surface, needs careful testing.
- **`/ai/v1/feedback` + favorites as ranking inputs** are user-writable → must be rate-limited and anomaly-scored or
  ranking integrity (§67) degrades into like-farming.
- **Prompt-injection is never fully "solved"** — the 100% containment gate covers the known suite; novel jailbreaks need
  red-team updates to `safety_injection_v1` ([TESTING.md](TESTING.md)).
