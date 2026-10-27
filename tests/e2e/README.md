# NEXUS browser & contract tests (Playwright)

Standalone package on purpose: it must be installable and runnable against a stack that other people
started, without dragging Next/FastAPI/Spring dependencies into the workspace.

## Prerequisites

The stack must already be running (spec §130 one-command dev):

```bash
make infra-up && make dev-platform && make dev-ai && make dev-web
```

| Env var | Default | |
|---|---|---|
| `NEXUS_WEB_URL` | `http://127.0.0.1:3000` | Next.js |
| `NEXUS_PLATFORM_URL` | `http://127.0.0.1:8080` | Spring Boot |
| `NEXUS_AI_URL` | `http://127.0.0.1:8000` | FastAPI |
| `NEXUS_E2E_WRITE_PATHS` | unset | opt in to mutating tests (reservation, checkout) |

`make e2e` exports all three, derived from the Makefile's own `WEB_PORT` / `PLATFORM_PORT` / `AI_PORT`, so a run
through make reads the stack make started rather than whatever answers on the default port. The defaults above
are what the harness uses when nothing is exported — the plane CI builds its own stack on — and
`scripts/check_plane_coordinates.mjs` is the reader that keeps those copies from drifting apart again.

```bash
npm install
npx playwright install chromium
npm test                 # everything
npm run test:api         # contract tests only (no browser)
npm run test:consumer
npm run test:merchant
npm run test:visual      # + --update-snapshots after a reviewed change
```

## Layout

```
lib/fixture.ts                     demo login, fact-vs-rendering audit, service request contexts
specs/consumer/vertical-slice.spec MVP acceptance path (spec §170) — the gate that matters
specs/merchant/journey.spec        onboarding → AI import → merchant agent → marketing draft → tenant isolation
specs/api/contract.spec.ts         docs/API_CONTRACT.md shapes, errors, pagination, idempotency, §105 degradation
specs/visual/quality.spec.ts       screenshots, 375px overflow, AA contrast, prefers-reduced-motion
```

## Rules for these tests

- A test encodes a contract or a spec section (`§`-numbered in its comment). If it fails, the fix is in the
  product, not by loosening the assertion.
- `test.skip` only for missing prerequisites (no seed data, service down) and always with a reason that
  names what to run. Never skip a journey assertion into green.
- Anything the product genuinely cannot do yet stays `test.fixme` with the blocked-on note, so the suite
  reports honest gaps instead of pretending.
- Screenshots used for review go to `../evidence/` (git-ignored contents); baselines go to
  `specs/visual/__snapshots__/` and change only in a deliberate commit.
