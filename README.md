# QinTopia PMS Core Operations MVP

QinTopia PMS is the source of truth for room/bed inventory, orders, stay fulfillment, member-night coverage, immutable pricing revisions, and manually recorded collection facts. The Web client and external-agent API use the same authenticated `/api/v1` command handlers and PostgreSQL transactions.

Changes to `main` go through pull requests. See the [PR format and repository protection guide](docs/repository-contributing.md) for required checks, review, and merge permissions.

AI 助手的提问记录保存在现有 PostgreSQL。Codex 同步和分析应先阅读 [AI 提问记录：存储位置与只读导出指南](docs/operations/ai-question-records.md)；无需额外分析界面，导出数据不得随代码提交。

## Releases

Application versions follow semantic versioning, starting with `v1.0.0`. Every deployed release must have a unique Git tag, optimization notes and upgrade instructions. See [CHANGELOG](CHANGELOG.md) and the [release procedure](docs/releases/README.md). `npm run build` checks release metadata and documentation; `/api/v1/version` reports the running application version.

Production release setup and daily operations are described in the [quickstart](docs/operations/production-release-quickstart.md), with recovery details in the [runbook](docs/operations/production-release-runbook.md). Merging a Release Please version PR and publishing its Draft GitHub Release triggers testing, a clean image build, private COS storage, and automatic deployment through restricted SSH. Rollback is available from GitHub Actions. Initial COS and server setup still requires operator configuration and real deployment validation. Run `npm run test:release` for the offline fake COS/Docker/SSH checks.

## Prerequisites

- Docker Engine with Compose v2 for the one-command path; this path does not require host Node.js
- Node.js 22.x LTS and npm 10 or newer for local development and test commands
- Runtime and integration tests use real PostgreSQL; there is no SQLite or in-memory fallback. The local Compose default remains PostgreSQL 16, but the event integration acceptance ran on PostgreSQL 18 and the v1.3.2 release record identifies production PostgreSQL 18.4. PostgreSQL 16 is not verified for the current event readiness fingerprint. See [database target and release prerequisites](待开发项/PMS-AgentOS-版本收口与PR准备-20260911.md#数据库目标与发布前缺项) before using the current event module or choosing a deployment target.
- Playwright Chromium for browser acceptance: `npx playwright install chromium`

## Start with Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

The copied `.env.example` sets `SEED_DEMO_DATA=true`, selects the reviewed `demo` staff profile for the app, and keeps the pre-seed migration profile `unconfigured`; the app waits for PostgreSQL, applies migrations, inserts idempotent demo data, and starts the built API/Web server. Compose itself defaults seeding to `false` and the staff profile to `unconfigured`, so a production image run does not seed public demo credentials or trust a database-selected profile unless those settings are explicitly changed.

## Start for development

```bash
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run db:import:2026
STAFF_PROFILE_MANIFEST_NAME=demo npm run dev
```

Preview the bundled Feishu import without touching PostgreSQL with `npm run db:import:2026 -- --dry-run`. The import is optional, transactional, and idempotent; Docker startup can opt in with `IMPORT_2026_REFERENCE_CATALOG=true`. Run it only after the target property exists. `REFERENCE_CATALOG_PROPERTY_ID` and `REFERENCE_CATALOG_PROPERTY_CODE` must identify that property's exact code, `Asia/Shanghai` timezone, and `CNY` currency. The importer never creates properties or executable inventory, pricing, member-contract, or entitlement facts.

If the local Docker installation has no Compose plugin, start the same database directly:

```bash
docker run --name qintopia-postgres \
  -e POSTGRES_USER=qintopia \
  -e POSTGRES_PASSWORD=qintopia \
  -e POSTGRES_DB=qintopia \
  -p 55432:5432 -d docker.m.daocloud.io/library/postgres:16-alpine
```

Set `POSTGRES_IMAGE=postgres:16-alpine` when Docker Hub is directly reachable. The Compose default is a transparent mirror of the official image because it is reachable from the current development environment.

Open:

- Web: `http://127.0.0.1:4173` in development, `http://127.0.0.1:4100` in the Docker build
- OpenAPI UI: `http://127.0.0.1:4100/docs`
- OpenAPI 3.1 JSON: `http://127.0.0.1:4100/api/v1/openapi.json`
- Liveness: `http://127.0.0.1:4100/health/live`
- Readiness: `http://127.0.0.1:4100/health/ready`

## Demo identities

| Client | Credential | Effective access |
|---|---|---|
| Web operator | `operator` / `demo-pass-2026` | WRITE on `prop_qintopia_demo` |
| External agent | Bearer `qtp_demo_read_token_2026` | READ ceiling |
| External agent | Bearer `qtp_demo_write_token_2026` | WRITE ceiling |

Tokens are opaque; only SHA-256 hashes are stored. A Token is bound to one real subject and one property, and its effective access is the intersection of the subject's current grant and the Token ceiling. `ISSUE_TOKEN`, `ROTATE_TOKEN`, and `REVOKE_TOKEN` use the same Preview/Confirm/Receipt protocol. For issue or rotation, the client must generate a cryptographically secure 256-bit `qtp_` base64url `tokenSecret` and submit it in the Preview request. The server hashes it before persistence; neither the Preview nor the Receipt returns the secret. A rotated Token is revoked immediately, so the client must retain the replacement secret it generated.

Members have an immutable internal `memberId` and a unique normalized identity-card business key, plus staff-entered name, phone, and WeChat fields. Search and balance queries resolve the person by identity card while orders and ledger facts retain internal IDs. A Feishu Base `record_id` identifies one stay application, not a person: repeated applications append independent `FEISHU_BASE` external-reference rows linked to the matched member. Base cannot create, freeze, release, or consume entitlement and PMS correctness never depends on a Base write-back.

## Agent command protocol

Every business write requires `Idempotency-Key` and `X-Correlation-ID`. `POST /api/v1/quotes` is the one low-risk, single-stage command: READ access is sufficient, it does not use Preview/Confirm, and it returns `{ quote, receipt }`. The Quote row, `CREATE_QUOTE` execution, audit entry, and permanent Receipt commit in one transaction. Replaying the same key and payload returns that same Quote and Receipt.

High-risk commands are two-stage:

1. `POST /api/v1/command-previews` with a command type and input.
2. Present the returned effect to a human or policy gate.
3. `POST /api/v1/command-previews/{previewId}/confirm` with the Preview's exact `propertyId` and `commandType`, `confirmation: true`, its exact `effectHash` as `expectedEffectHash`, and a structured reason.
4. Store the returned `commandId` and `receiptId`.

Confirm locks and revalidates authorization, aggregate versions, inventory day slots, membership ledger state, and the locked pricing policy. A changed or expired Preview returns a durable `NOT_EXECUTED` Receipt and performs zero domain writes. Replaying the same subject/command/idempotency key and request returns the original Receipt; changing the request returns `IDEMPOTENCY_KEY_REUSED`.

`CREATE_ORDER` requires one stable `bookingChannelCode`: `YOUMUDAO`, `CTRIP`, `MEITUAN`, or `WECOM`. `channelOrderReference` is optional, but must be `null` for `WECOM`. External-channel orders do not accept individual lodging collections or refunds; finance later reconciles their channel order reference and current channel settlement amount.

For operator-recorded lodging funds, a new WeCom collection requires its WeCom transaction reference and a bank-transfer collection requires its transfer reference. Cash has no external transaction reference and instead requires the collector's name; `OTHER` has no external transaction reference and requires a collection explanation. Every refund references exactly one original collection, cannot exceed that collection's remaining refundable amount, and requires a refund reason. A WeCom refund is returned through the original route and retains the original collection transaction reference; a bank-transfer refund requires its own transfer reference. These manually recorded values do not prove external receipt, settlement, reconciliation, or write-off, and are never replaced by Fact, Receipt, Command, correlation, or idempotency identifiers. Historical rows may return `null` when no reference was recorded.

Every new normal or free-stay order also requires a trimmed, nonblank `primaryGuest.nickname` of at most 200 characters. It is stored with the immutable primary-guest snapshot and returned through Preview, Receipt, order queries, amendments, and room status. Historical snapshots may return a missing or `null` nickname; the Web derives the “历史未记录” compatibility label without persisting a fabricated value.

After a network interruption, the following GET endpoints are observational only. A missing execution returns `UNKNOWN`; a read cannot prove that a delayed request will never arrive:

```text
GET /api/v1/commands/{commandId}
GET /api/v1/command-results?propertyId=prop_qintopia_demo&commandType=CREATE_QUOTE&idempotencyKey=...
GET /api/v1/command-results?propertyId=prop_qintopia_demo&commandType=CREATE_ORDER&idempotencyKey=...
GET /api/v1/receipts/{receiptId}
```

To close an interrupted request safely, call `POST /api/v1/command-results/resolve` with fresh command headers and the original request identity in the body:

```json
{
  "propertyId": "prop_qintopia_demo",
  "commandType": "CREATE_ORDER",
  "idempotencyKey": "the-original-confirm-idempotency-key"
}
```

The resolver uses the same per-command execution lock as Quote and Confirm. It returns an existing durable result when one exists; otherwise it atomically records `NOT_EXECUTED` and permanently fences that original key before allowing another attempt. Results are `EXECUTED`, `NOT_EXECUTED`, or `UNKNOWN`. Do not retry an `UNKNOWN` command with a new key.

`CREATE_QUOTE` is a low-risk single-stage command: READ access is sufficient and Preview/Confirm do not apply, but both command headers, a durable Receipt, audit, idempotent replay, and recovery still apply. Expired Quotes cannot create an order, but their rows are retained and the durable Receipt permanently embeds the original Quote snapshot; only unexpired Quotes count toward the per-subject/property active quota.

## Pricing and inventory boundary

The verified Feishu revision 561 facts are normalized into an immutable catalog: 8 room categories, 44 physical rooms, 91 physical beds, 31 independent room-sale units, and 46 independent bed-sale units. Those 77 base units are the simultaneous-inventory denominator. The 13 dorm whole-room combinations lock their underlying beds and raise the queryable sales-entry count to 90 without creating extra capacity. The rejected source figure 97 remains provenance only and is never used as inventory. No separate electricity charge or electricity cash line is produced.

`policy_qintopia_public_2026_rev561_v1` is the executable, locked public-price policy. It is effective from `2026-02-25` with an open end date and contains 10 product anchor sets. The floor-price worksheet and the rounded-daily-price worksheet are excluded. Read the sealed evidence through `GET /api/v1/properties/{id}/reference-catalog`.

For a continuous stay of `N` nights, the policy uses `P1` for `N < 7`, `P7/7` for `7 <= N < 14`, `P14/14` for `14 <= N < 30`, and `P30/30` for `N >= 30`. Extension, shortening, cross-month stays, and same-Stay moves select the band from the complete interval beginning at the original arrival. Cross-product moves price each segment with that one band's product anchor, sum exact segment amounts, and half-up round the final stay total once to a whole CNY yuan. Boundary price decreases are accepted. An order continues using its locked policy version even after another version is published.

Manual repricing accepts a non-negative whole-yuan final target, stores the policy base, and derives the current revision's adjustment as `target - policyBase`. A later stay amendment recomputes from policy and does not inherit that adjustment. `policy_free_v1` keeps FREE stays at zero through all amendments and never touches membership.

Member coverage is a concrete set of service dates backed by matching ROOM_NIGHT or BED_NIGHT lots. Reservation confirmation freezes available dates. Uncovered dates are priced individually at the locked product's `P1`, even when their count reaches a duration anchor. A later auditable entitlement lot can cover previously uncovered dates before final fulfillment; recorded cash is not automatically refunded. Successful CHECK_IN converts held coverage to consumed coverage. Pre-check-in cancellation or no-show releases held dates; ordinary cancellation or shortening never restores consumed entitlement. Membership purchase fees are non-refundable.

The demo-only `policy_transient_v1` remains a clearly labelled fixed-rate fixture for protocol regression tests. It is not the QinTopia 2026 public-price policy.

The only recomputed amount fields are:

- `currentContractAmount`
- `netRecordedCollection`
- `collectionDifference`

They do not mean paid, settled, receivable, refundable, recognized revenue, or external bank confirmation.

## Verification

With PostgreSQL running:

```bash
npm run verify
npm run test:integration
npm run build
npm run test:contract
npm run test:e2e
npm run test:pricing-facts
npm run verify:cold-start
npm run verify:compose
./scripts/verify-backup-restore.sh
```

For a workspace where the host TypeScript runtime cannot execute reliably, build one immutable verification image and use it for the two operational proofs. The default host paths remain unchanged:

```bash
docker build -t qintopia-pms:verify .
VERIFY_APP_IMAGE=qintopia-pms:verify npm run verify:cold-start
VERIFY_APP_IMAGE=qintopia-pms:verify npm run verify:restore
```

Containerized browser runners may use an installed Chromium binary by setting `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; ordinary local Playwright runs continue to use the configured Playwright browser.

`npm run verify:compose` proves the documented Compose path with an isolated project, container, ports, and volume, then removes only those resources. It auto-detects the Docker Compose plugin or standalone binary; set `COMPOSE_BIN=/path/to/docker-compose` when neither is on `PATH`.

`npm run test:pricing-facts` executes the owner-confirmed finite examples in `docs/pricing-facts/cases` against the production domain implementation. Any missing scenario, schema mismatch, placeholder evidence, or amount difference fails the gate.

The database suites terminate connections to, drop, and recreate dedicated databases. By default these are `qintopia_test`, `qintopia_command_protocol`, `qintopia_quote_command`, `qintopia_database_invariants`, `qintopia_pricing_policy_guard`, `qintopia_reference_catalog`, `qintopia_security_integration`, `qintopia_receipt_references`, `qintopia_operational_references`, `qintopia_operational_references_history`, `qintopia_member_profile_lifecycle`, `qintopia_member_entitlement_expiry`, `qintopia_security_contract`, `qintopia_agent_journey_contract`, `qintopia_effect_contract`, and `qintopia_e2e`. The migration-concurrency acceptance also creates and removes a PID-scoped `qintopia_migration_concurrency_*` database. Never point a test database environment variable at a database containing retained data.

The reset-capable portions of the public `test:integration`, `test:contract`, and `test:e2e` commands hold coordination and cleanup-guard PostgreSQL session advisory locks for their child process lifetime. The integration command first runs the lock runner's own signal and process-group self-tests outside that runner's process tree, then acquires the shared lock for every business integration test. This prevents a self-test that intentionally sends `SIGTERM` from terminating the outer integration fence while keeping all fixed-database resets serialized.

The lock runner requires a POSIX host (Linux or macOS) and fails before connecting on Windows because Node cannot verify descendant process groups there. It starts the suite root in its own process group and periodically records that root plus every observed descendant PGID, including descendants that create a new session. Independent invocations using the same coordinator database and lock ID may be started concurrently; they wait and then run serially before any fixed database reset or E2E port binding can overlap. Different `TEST_SUITE_LOCK_DATABASE_URL` or `TEST_SUITE_LOCK_ID` values are separate coordination domains and do not make shared E2E ports safe.

The `*:run` scripts are private implementation details and must not be called directly. Their environment marker is an accidental-use guard, not a security capability or proof of lock ownership; a developer who controls the shell can also invoke the underlying test tools directly. The default wait limit is ten minutes and can be changed with `TEST_SUITE_LOCK_TIMEOUT_MS`. `TEST_SUITE_LOCK_DATABASE_URL` must identify a stable administrative database, with a database name distinct from every reset target, used only to own the locks. The runner never creates or drops that database.

If one lock connection is lost while the other survives, the runner retains the surviving fence until a fresh process-tree snapshot succeeds and every observed descendant group is proven gone. Snapshot, signal, or liveness errors keep that fence held and are retried instead of failing open; cleanup never kills the root after a failed fresh snapshot because that could erase the ancestry of a not-yet-observed detached group. Once a PGID has been observed it remains tracked even after reparenting. If both sessions in the same PostgreSQL failure domain are lost together, PostgreSQL has already released both locks and cannot fence a successor; the runner escalates observed child cleanup to `SIGKILL`, but this only shortens the exposure and is not a serialization guarantee. Keep the coordinator available for the entire suite, and after a coordinator restart do not start a successor until the previous runner and all observed groups are confirmed gone.

This is user-space POSIX tracking, not a kernel cgroup: a short-lived child that creates an independent session and loses its observable parent entirely between two process snapshots can never be discovered afterward. Suite commands must not intentionally daemonize in that interval. The runner lowers the exposure with frequent snapshots and verifies the actual Playwright API/Vite descendant groups before releasing its fence. No lock file or randomly named database is left behind. The suites use independent connections internally to prove whole-room/bed mutual exclusion, different-bed coexistence, stale Preview rollback, idempotency, Receipt atomicity, stay changes, collections/refunds, fulfillment, and Token lifecycle.

## Backup and restore

Create a compressed PostgreSQL backup:

```bash
./scripts/backup.sh
```

Restore into a database name that does not already exist. The script refuses both the configured live database and every existing target database:

```bash
ALLOW_RESTORE=true ./scripts/restore.sh backups/qintopia-YYYYMMDD-HHMMSS.dump qintopia_restored
```

Run the automated recovery proof:

```bash
./scripts/verify-backup-restore.sh
```

Container name, database, and database user can be overridden with `POSTGRES_CONTAINER`, `POSTGRES_DB`, and `POSTGRES_USER`.

## Repository map

- `packages/contracts` - stable DTO vocabulary, command types, error codes, IDs, Receipts
- `packages/domain` - date, pricing, access ordering, hashing, and amount invariants
- `packages/db` - PostgreSQL migration, seed, day-slot locking, repositories, command transactions
- `apps/api` - authentication, `/api/v1`, OpenAPI, health/readiness, static Web hosting
- `apps/web` - operational room board, order workspace, and mobile fulfillment
- `tests` - domain, real-PostgreSQL integration, OpenAPI contract, and browser E2E tests
- `docs/pricing-facts` - schema and intake format for real pricing golden cases

No previous PMS, migration adapter, compatibility service, projection write-back, payment gateway, accounting ledger, dynamic formula engine, Redis, or queue is used.
