# Usage Metering Service

Multi-tenant usage-metering API: accounts and users with monthly allowances and per-request limits, enforced atomically under concurrency.

Stack: Node.js 24, Fastify, PostgreSQL 17 (raw SQL, no ORM), Docker Compose, Vitest, k6.

## Run

```
docker compose up --build
```

Starts Postgres, the service (port 3000, migrations and predefined plans applied automatically) and a demo client that runs the scenarios below and prints every decision, then exits. Re-run the demo on its own: `docker compose run --rm client`

What the demo shows (read the output top to bottom):

| # | Scenario |
|---|---|
| 1-2 | Accepted request, then the same `requestId` retried (not counted twice) |
| 3 | Rejected by the **user** per-request limit |
| 4 | Rejected by the **account** per-request limit (user plan allows more than the account plan) |
| 5 | Rejected by the **user** monthly allowance |
| 6-8 | Custom plan created, user upgraded, the same amount now accepted |
| 9-13 | Account switched to a small custom plan: rejected by the **account** shared monthly allowance while the user still has allowance left |
| 14-15 | Plan updated through the API, request accepted, no client change and no redeploy |
| 16 | Another account cannot read this account's user |

For clean demo output (no service logs): `LOG=off docker compose up --build`
## Tests

Needs the database running:

```
docker compose up -d db
cd service
cp .env.example .env     # optional: tests fall back to the same default URL
npm install
npm test
```

## API

All routes except `/health`, `/plans` and `POST /accounts` require the `x-api-key` header.

| Route | Purpose |
|---|---|
| `GET /plans` | Predefined plans |
| `POST /accounts` | Create account, returns the API key once |
| `GET /account` | Current account and its plan |
| `PUT /account/plan` | Switch the account plan (predefined or own custom account plan) |
| `POST /users`, `GET /users/:id`, `PUT /users/:id/plan` | Register users, view, change plan |
| `POST /custom-plans`, `GET /custom-plans`, `PUT /custom-plans/:id` | Per-account custom plans (`scope` is `account` or `user`) |
| `POST /consume` | Record usage (`userId`, `requestId`, `units`) |
| `GET /usage`, `GET /usage/users/:id` | Used and remaining for a month (`?month=YYYY-MM`) |
| `GET /history` | Request log, newest first (`limit`, `offset`, `userId`, `month`) |

Predefined plans: account Starter (10000 / 100 per request), Pro (100000 / 1000); user Basic (1000 / 20), Premium (10000 / 200). They are read-only.

### Getting and using an API key

```
PLAN=$(curl -s localhost:3000/plans | jq -r '.[] | select(.name=="Starter") | .id')

curl -s -X POST localhost:3000/accounts \
  -H 'content-type: application/json' \
  -d "{\"name\":\"acme\",\"planId\":\"$PLAN\"}"
# {"id":"...","name":"acme","plan_id":"...","created_at":"...","apiKey":"um_..."}   <- shown once, store it

KEY=um_...
BASIC=$(curl -s localhost:3000/plans | jq -r '.[] | select(.name=="Basic") | .id')

curl -s -X POST localhost:3000/users -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"externalId\":\"alice\",\"planId\":\"$BASIC\"}"

curl -s -X POST localhost:3000/consume -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"userId":"alice","requestId":"req-1","units":10}'
# 200 {"accepted":true,"units":10,"rejectedRule":null,"rejectedLevel":null,"duplicate":false}

curl -s -X POST localhost:3000/consume -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"userId":"alice","requestId":"req-2","units":25}'
# 422 {"accepted":false,"units":25,"rejectedRule":"per_request","rejectedLevel":"user","duplicate":false}

curl -s localhost:3000/usage/users/alice -H "x-api-key: $KEY"
# {"month":"2026-10","allowance":1000,"used":10,"remaining":990}
```

Errors are `{ "error": "<code>" }`: `missing_api_key`/`invalid_api_key` (401), `user_not_found`/`plan_not_found` (404), `invalid_plan`/`invalid_month` (400), `user_already_exists`/`plan_name_exists`/`request_id_conflict` (409). Rejected consumption returns 422.

## Rules

Evaluated in this order; the first one that fails rejects the request and is recorded with its rule and level:

1. per-request limit on the user's plan
2. per-request limit on the account's plan
3. monthly allowance on the user
4. monthly allowance on the account

Rejected requests return HTTP 422 with `rejectedRule` (`per_request` | `monthly`) and `rejectedLevel` (`user` | `account`), and do not consume allowance. Accepted units are added to the user's and the account's counters for the current UTC month in the same transaction.

## Plan changes

- A plan change (switching a plan, or editing a custom plan) applies to requests processed after the change commits.
- Units already consumed in the month are kept. Switching plans never grants a fresh allowance.
- If an allowance is lowered below current usage, `remaining` is shown as 0 and further consumption is rejected at that level.
- History is never rewritten: each logged request stores the limits that applied to it in `applied_limits`.
- Editing a custom plan affects every account/user assigned to it. Users sharing a plan share the definition, not the usage.

## Product assumptions

- One resource type; units are positive integers.
- Months are UTC calendar months. Usage belongs to the month in which the request is processed.
- `/usage?month=` for a past month reports the usage of that month against the **current** plan's allowance (the plan history is not versioned). The per-request log keeps the limits that actually applied.
- The order of rule evaluation above determines which rule is reported when several would fail.
- A `requestId` is unique per account and forever (not per month). Retrying the same `requestId` with the same user and units replays the original decision with `duplicate: true`, including a replayed rejection. Reusing it with a different user or amount returns 409 and counts nothing. To retry after a plan change, send a new `requestId`.
- Rejections are logged in history like accepted requests. Unknown users return 404 and are not logged.
- Predefined plans are read-only and shared; custom plans belong to one account and cannot be used by another.
- A custom plan is bound to a scope (`account` or `user`) at creation and cannot be assigned to the other kind of entity.
- Plan names are unique per account and scope.
- Account creation is open (no authentication) because the brief has no end-user login.

## Design decisions

- **Concurrency:** `/consume` runs in one transaction and takes `SELECT ... FOR UPDATE` on the account's monthly counter row. Concurrent requests for the same account are serialized, so two requests can never both see the same remaining balance. A test fires 20 concurrent requests against a balance of 100 and asserts exactly 10 are accepted.
- **Idempotency:** `UNIQUE (account_id, request_id)` plus a check after the lock. A retried `requestId` returns the original result with `duplicate: true` and is never counted twice, including when the duplicates arrive concurrently.
- **Fresh plan read:** the account's plan is read inside the transaction after taking the lock, so a plan switch that committed while the request was waiting is honoured.
- **Counters:** per-account and per-user monthly counters are updated in the same transaction, so they cannot diverge. One row per (entity, month) means each month starts from zero and past months stay queryable.
- **Preserving history:** every logged request stores `applied_limits` (jsonb), the limits in force at that moment.
- **API keys:** stored as SHA-256 hashes, shown once at creation. SHA-256 (not bcrypt) because the keys are 192-bit random values, not guessable passwords.
- **Tenant isolation:** every query is scoped by the `account_id` resolved from the API key, never taken from the request body. Tests cover read, consume, plan edit and history across accounts.
- **Migrations:** plain SQL files applied in order on startup, each once, inside a transaction.

## Performance

Tool: [k6](https://k6.io), constant arrival rate of 200 requests/s for 30 s against `/consume`, 5 units per request, 5 users per account on the Pro/Premium plans. Everything (k6, service, Postgres) ran on one Windows laptop under Docker. The script's `teardown` sums the usage of every account, so correctness can be checked against the number of accepted requests.

Reproduce (service and DB running; the network name is `<project folder>_default`):

```
docker compose up -d db service

# worst case: one account, every request contends for the same row lock
docker run --rm -i --network usage-metering_default -v "$(pwd)/k6:/scripts" \
  -e ACCOUNTS=1 grafana/k6 run /scripts/load.js --summary-export=/scripts/summary-single-account.json

# realistic: 20 accounts in parallel
docker run --rm -i --network usage-metering_default -v "$(pwd)/k6:/scripts" \
  -e ACCOUNTS=20 grafana/k6 run /scripts/load.js --summary-export=/scripts/summary-multi-account.json
```

(PowerShell: replace `$(pwd)` with `${PWD}`. Other knobs: `RATE`, `DURATION`, `USERS_PER_ACCOUNT`, `API_URL`.) Raw console output from the runs is in `k6/`.

| Scenario | Throughput | p95 | Failures |
|---|---|---|---|
| 1 account (worst case, one lock) | about 87 to 120 req/s | 2.2 to 3.1 s | 0% |
| 20 accounts (realistic) | 196 req/s | 160 ms | 0% |

Correctness under load: in the 20-account run, total units consumed was 29935 = 5987 requests x 5 units, i.e. every request was counted exactly once and no account went over its limit.

What I learned: all requests for one account queue on the same row lock, which is the deliberate price of never exceeding a limit. Throughput per account is therefore bounded by how long the critical section is, while different accounts proceed in parallel. The single-account run misses the p95 < 500 ms threshold; this is reported as measured, not tuned away.

Known improvements, not done: shorten the critical section (read user data and merge the "ensure row + lock" round trips) and re-measure; compile to JavaScript instead of running through tsx; benchmark on dedicated hardware.

## Known limitations

- Per-account throughput is limited by the row lock (see Performance); there is no batching of units.
- A past month's usage is compared with the current plan, not the plan of that month.
- Plans cannot be deleted; accounts, users and API keys cannot be deleted or rotated.
- No rate limiting or authentication on `POST /accounts`.
- Single Postgres instance, no read replicas or partitioning of the history table.
- Month boundaries use the server clock in UTC; a request waiting on the lock at midnight is counted in the month it started in.

## Layout

```
service/   Fastify API, migrations, tests
client/    Demo client (CLI)
k6/        Load scripts and results
docker-compose.yml
```