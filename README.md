# Nawilis SPK → Turboly Bridge

Capture the paper **SPK (Surat Perintah Kerja)** work order at the counter, store it in
**MongoDB**, and — once the job is **given to a mechanic** — automatically create the matching
**Service Order** in **Turboly** and verify it landed correctly.

> Scope: **Form A (SPK)** only. Form B (Check-and-Go inspection) is a later phase and maps to
> Turboly's **Inspections** tab on the same Service Order.

## The core idea

```
BRANCH (×23)                    CLOUD                                  TURBOLY
─────────────                   ─────────────────────────────         ───────────────
 Tablet intake  ──POST /api/spk──►  MongoDB  (SYSTEM OF RECORD)
 (typed, ≤30s)                      state: captured→…→validated
                                        └─► awaiting_assignment   ◄── parked, NOT pushed
                                                  │
 Mechanic scans QR ticket ──POST /api/spk/:id/assign──► state: queued
                                                  │
                          worker poller (only `queued` = assigned jobs)
                                                  │
                                     BullMQ ─► push worker ──(Playwright)──► New Service Order
                                                  │                          REFERENCE = SPK:<ulid>
                                     verifier ◄───┘  read-back by token ───► /service_orders list
                                                  │
                                     state: confirmed ✓
```

**Only Service Orders actually given to a mechanic are pushed.** Walk-in estimates that never
become jobs sit in `awaiting_assignment` and are never sent to Turboly (declined → `voided`).

## Monorepo layout

| Package | What |
|---|---|
| `packages/core` | Domain model, state machine, Indonesian parsing (plate/KM/WA), 3-layer validation, Mongo layer, and the **Turboly Playwright adapter** (`src/turboly/`). |
| `apps/web` | Next.js — the offline-first intake PWA (`/`), the ops dashboard (`/admin`), and the ingest/assign/void API. |
| `apps/worker` | Persistent Node service — BullMQ queues, the poller, the push-worker fleet (lease fencing, retry classification, circuit breakers), the verifier, the reconciler, and the degradation ladder. |
| `tools/turboly-capture` | One-time helper to confirm the Turboly selector map against your sandbox. |

The Turboly DOM is encoded in exactly one file: **`packages/core/src/turboly/selmap.ts`**,
built from the sandbox screenshots. Everything else is generic.

## Prerequisites

- Node ≥ 20, Docker (for local Mongo/Redis/MinIO).
- A Turboly login. **Start against `live.turboly.com`** — never production until the smoke
  test is green.

## Setup

```bash
cp .env.example .env          # then fill it in (see below)
npm install                   # installs all workspaces
npx playwright install chromium   # one-time browser download for the worker/capture tool

npm run infra:up              # Mongo (replica set) + Redis + MinIO via docker compose
npm run build -w @spk/core    # compile the shared package
npm run seed:refdata -w @spk/core   # ensure indexes + degradation singleton
```

### Import your Turboly master data (required before any push)

Export **Stores**, **Service Products**, and **Mechanics/Advisors** from Turboly's UI, shape
them into one JSON file (see `packages/core/src/seed/turboly-import.ts` for the format), then:

```bash
npm run seed:turboly -w @spk/core -- ./turboly-export.json
```

This fills `tb_stores`, `tb_service_products`, `tb_mechanics` and builds an **unconfirmed**
service→SKU map. Nothing pushes with an unconfirmed/missing SKU (real SKUs are never invented).

### Store per-branch Turboly credentials (encrypted at rest)

```bash
# one-time master key:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → CREDENTIAL_ENC_KEY in .env

CREDENTIAL_ENC_KEY=<key> npm run -w @spk/core exec tsx src/seed/set-credential.ts -- NWL-BKS user@nawilis.com 'password'
```

## Confirm the Turboly selector map (do this once)

```bash
npm run capture:turboly       # opens sandbox; log in by hand; it verifies every selector
```

Fix any `✗` in `packages/core/src/turboly/selmap.ts` (use `npm run codegen -w @spk/turboly-capture`
to grab a locator). This is the only file expected to need tweaks after the first run.

## Run

```bash
npm run dev:web               # http://localhost:3000  (intake + /admin)
npm run dev:worker            # the push/verify/reconcile service
```

- `PUSH_MODE=manual` (default): captures + parks everything; pushes nothing. Safe first run.
- `PUSH_MODE=rpa`: fully-automatic push into Turboly once a mechanic is assigned.

## Use web-based MongoDB (Atlas) instead of local

The app reads `MONGODB_URI` everywhere, so switching from the local DB to the
cloud is one line — no code changes.

1. Create a free cluster at **https://www.mongodb.com/cloud/atlas** (M0 Free).
2. **Database Access** → add a user (e.g. `spkuser`) + password.
3. **Network Access** → add your IP, or `0.0.0.0/0` for dev.
4. **Connect → Drivers** → copy the SRV string, and put it in `.env`:
   ```
   MONGODB_URI=mongodb+srv://spkuser:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   (URL-encode special chars in the password: `@`→`%40`, `#`→`%23`.)
5. Verify + seed the cloud DB, then run the app:
   ```
   npm run db:check       # → should say "Atlas (cloud)" + ✓ connected
   npm run seed:refdata   # indexes + degradation on the cloud DB
   npm run seed:demo      # optional demo mirror
   npm run dev:web        # form now reads/writes Atlas (restart to pick up .env)
   ```

Data then lives in the cloud — accessible anywhere, with Atlas backups. You no
longer need `npm run dev:mongo`. To go back to local, restore the localhost URI.

## Recommended rollout (sandbox first)

1. `PUSH_MODE=manual`, one pilot branch → confirm intake, history, the awaiting-assignment queue.
2. `capture:turboly` green on **sandbox** → `PUSH_MODE=rpa`, `TURBOLY_BASE_URL=https://live.turboly.com`.
   Assign a test SPK; watch it reach `confirmed`; check the read-back in the SO list.
3. Run the canary + reconciler for a day on sandbox; verify zero double-pushes.
4. Point `TURBOLY_BASE_URL` at production, one branch, watch the dashboard, then widen.

## The three-layer validation

1. **Layer 1 (form)** — plate format + OCR correction, `KM` `.`=thousands, WA E.164 + operator
   prefix, brand/model/year sanity, ≥1 job line. Runs on device and server.
2. **Layer 2 (pre-push)** — store resolves, every SKU exists, `ODOMETER`/`SERVICE ADVISOR`/
   `SALESPERSON` present (Turboly requires them), KM monotonic vs history. Unknown SKU blocks;
   unknown customer never blocks (created on push).
3. **Layer 3 (post-push reconciliation)** — read-back by correlation token off the persistent
   Service Order list (store + line count + odometer), plus a nightly token set-diff that reads
   **zero** on a good day and pages on any double-push.

## Safety properties (fully-automatic push)

- **No double-push:** CAS state transitions + a unique claim table on `(correlationToken, phase)`
  + lease fencing re-asserted before every irreversible click.
- **No silent breakage:** structural canary + circuit breaker; identical cross-branch errors are
  read as a Turboly UI change, not a data error.
- **Degrades automatically, resumes only with a human.** Ladder: full auto → sampled audit →
  assisted entry → manual. Capture never stops, even fully offline.
- **Defensible automation:** business-hours window, static disclosed egress IP (network layer),
  honest UA suffix, serial per-branch sessions — never scale workers up to drain a backlog.

## Environment

See `.env.example`. Key ones: `MONGODB_URI`, `REDIS_URL`, `TURBOLY_BASE_URL`, `PUSH_MODE`,
`CREDENTIAL_ENC_KEY`, `MAX_BROWSER_WORKERS`, `PUSH_WINDOW_START/END`.

## Not yet wired (honest status)

- The RPA **selector map** is built from screenshots; `capture:turboly` confirms/finalises it.
- The nightly reconciler's **list-harvest** for RPA mode is stubbed (`apps/worker/src/index.ts`
  `runReconcile`); per-record verification is fully implemented. Wire the 72h list scrape when
  the selector map is confirmed.
- Photo-of-paper **AI extraction** is deferred by design (UU PDP cross-border gate); images are
  stored in-region first. Typed intake is complete and 100% accurate by construction.
- Form B (Check-and-Go) intake + the Inspections-tab mapping.
