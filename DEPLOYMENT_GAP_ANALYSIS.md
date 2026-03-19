# Insta AI Deployment Gap Analysis

Date: 2026-03-19
Scope reviewed: `backend/server.js`, `backend/db.js`, `backend/package.json`, `frontend/public/*.html`, `README.md`

## P0 - Must Fix Before Deployment

- [ ] **Remove committed dependencies and secrets risk**
  - `backend/node_modules` is present in repo/worktree.
  - No root `.gitignore`.
  - Action: add `.gitignore` (`node_modules/`, `.env`, logs, editor files), remove vendored deps from git, rotate any exposed keys.

- [ ] **Enforce secure JWT configuration**
  - `backend/server.js` falls back to `JWT_SECRET = 'change-me-in-production'`.
  - Action: fail startup when `JWT_SECRET` is missing/weak in non-local environments.

- [ ] **Harden CORS policy**
  - `app.use(cors())` allows all origins.
  - Action: restrict allowed origins by environment; allow credentials only if required.

- [ ] **Tighten proxy host validation (SSRF hardening)**
  - `audio-proxy` and `image-proxy` use broad hostname checks (`includes` / loose substrings).
  - Action: use strict allowlist with exact host or vetted subdomain matching; block private IP ranges; add URL scheme checks.

- [ ] **Add request rate limiting + abuse protection**
  - Auth and AI endpoints have no global rate limiting.
  - Action: rate-limit `/api/auth/*`, `/generate-persona`, `/chat`, `/instagram-posts`; add brute-force protection for login.

- [ ] **Add security middleware and production headers**
  - Missing `helmet`, CSP, and stricter HTTP security defaults.
  - Action: add `helmet`, define CSP (especially with CDN scripts), set `trust proxy` as needed for deployment platform.

- [ ] **Add structured error handling and startup env validation**
  - App does not validate required env vars at boot.
  - Action: validate `DATABASE_URL`, `GEMINI_API_KEY`, `RAPIDAPI_KEY`, `MURFAI_API_KEY`, `JWT_SECRET` before listening.

## P1 - Strongly Recommended Before Public Launch

- [ ] **Token storage hardening**
  - Frontend stores auth token in `localStorage`.
  - Action: migrate to `HttpOnly` secure cookies (or add strict CSP + XSS hardening if staying with localStorage).

- [ ] **Add auth essentials**
  - No logout endpoint/session invalidation, password reset, or email verification.
  - Action: add logout flow, forgot/reset password, optional email verification.

- [ ] **Add input validation/sanitization layer**
  - Username, persona IDs, and query params are minimally validated.
  - Action: use schema validation (`zod`/`joi`) on all request bodies/params/queries.

- [ ] **Add DB constraints/indexes for scale and correctness**
  - No uniqueness guard for one active persona per user.
  - Action: add partial unique index on `(user_id) WHERE is_active = true`; add indexes for frequent lookups.

- [ ] **API consistency cleanup**
  - Mixed route naming style (`/chat`, `/get-chat-history`, `/api/*`).
  - Action: standardize under `/api` and version endpoints.

- [ ] **Observability**
  - Heavy `console.log` usage, no request IDs, no centralized logging/metrics.
  - Action: add structured logger (pino/winston), error monitoring, latency/error dashboards.

- [ ] **Health/readiness endpoints**
  - No `/healthz` or `/readyz`.
  - Action: add liveness/readiness checks (DB connectivity, optional external dependency checks).

- [ ] **Retry/backoff strategy review for UX**
  - Long retry windows can hold user lock for up to ~120s.
  - Action: reduce lock scope, add per-request IDs, allow cancel/retry from client.

- [ ] **Case/style consistency in frontend routes**
  - Uses both `/chat` and `/Chat.html`.
  - Action: normalize to one canonical route to avoid environment-specific issues.

- [ ] **Remove stale/unused client code**
  - Unused `logoutHandler` in `Chat.html`.
  - Action: wire it to UI or remove.

## P2 - Product/Quality Gaps

- [ ] **Automated tests**
  - No project tests (unit/integration/e2e).
  - Action: add backend API tests, auth tests, critical chat-path tests.

- [ ] **CI pipeline**
  - No CI config for lint/test/build/security scan.
  - Action: add CI workflow (install, lint, test, basic smoke test).

- [ ] **Dependency and security scanning**
  - No audit workflow.
  - Action: add `npm audit`/SCA checks in CI, scheduled dependency updates.

- [ ] **Deployment artifacts**
  - No Dockerfile/compose/deploy manifests.
  - Action: add containerization + deployment docs for target platform.

- [ ] **README accuracy and polish**
  - README has encoding artifacts and optimistic claims (pricing tiers) that are not backend-enforced.
  - Action: clean encoding, align claims with implemented behavior, add production deployment section.

- [ ] **Data lifecycle policy**
  - No retention/cleanup policy for stored chats/personas.
  - Action: define retention, user delete/export controls, and cleanup jobs.

- [ ] **Privacy/compliance pages**
  - UI links exist for Terms/Privacy but not implemented.
  - Action: add real policy pages before public deployment.

## Suggested Execution Order

1. Repo hygiene + secrets + env validation
2. Security hardening (JWT, CORS, SSRF, rate limits, headers)
3. Stability/ops (health checks, logging, indexes)
4. Auth/product essentials (reset/logout, token strategy)
5. Testing + CI + deployment automation
6. Docs/compliance polish

