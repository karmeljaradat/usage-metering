# Usage Metering Service

Multi-tenant usage-metering API: accounts and users with monthly allowances and per-request limits, enforced atomically under concurrency.

Stack: Node.js 24, Fastify, PostgreSQL 17 (raw SQL, no ORM), Docker Compose, Vitest, k6.

## Run

```
docker compose up --build
```

Starts Postgres, the service (port 3000, migrations and predefined plans applied automatically) and a demo client that runs the required scenarios and prints the results, then exits.

Run the demo again on its own: `docker compose run --rm client`

Tests (needs the DB running):

```
docker compose up -d db
cd service
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
| `POST /users`, `GET /users/:id`, `PUT /users/:id/plan` | Register users, view, change plan |
| `POST /custom-plans`, `GET /custom-plans`, `PUT /custom-plans/:id` | Per-account custom plans |
| `POST /consume` | Record usage (`userId`, `requestId`, `units`) |
| `GET /usage`, `GET /usage/users/:id` | Used and remaining for a month (`?month=YYYY-MM`) |
| `GET /history` | Request log, paginated (`limit`, `offset`, `userId`) |

Predefined plans: account Starter (10000 / 100 per request), Pro (100000 / 1000); user Basic (1000 / 20), Premium (10000 / 200).

## Rules

Evaluated in this order; the first one that fails rejects the request and is recorded with its rule and level:

1. per-request limit on the user's plan
2. per-request limit on the account's plan
3. monthly allowance on the user
4. monthly allowance on the account

Rejected requests return HTTP 422 with `rejectedRule` and `rejectedLevel`, and do not consume allowance.

## Design decisions

- **Concurrency:** `/consume` runs in one transaction and takes `SELECT ... FOR UPDATE` on the account's monthly counter row. Concurrent requests for the same account are serialized, so two requests can never both see the same remaining balance. A test fires 20 concurrent requests against a balance of 100 and asserts exactly 10 are accepted.
- **Idempotency:** `UNIQUE (account_id, request_id)` plus a check after the lock. A retried `requestId` returns the original result with `duplicate: true` and is never counted twice, including when the duplicates arrive concurrently.
- **Counters:** per-account and per-user monthly counters are updated in the same transaction, so they cannot diverge. One row per (entity, month) means each month starts from zero and past months stay queryable.
- **Preserving history:** every logged request stores `applied_limits` (jsonb), the limits in force at that moment. Changing a plan later does not rewrite history.
- **API keys:** stored as SHA-256 hashes, shown once at creation. SHA-256 (not bcrypt) because the keys are 192-bit random values, not guessable passwords.
- **Tenant isolation:** every query is scoped by the `account_id` resolved from the API key, never taken from the request body. Tests cover read, consume, plan edit and history across accounts.
- **Migrations:** plain SQL files applied in order on startup, each once, inside a transaction.

## Performance

k6, 200 requests/second for 30s against `/consume`, everything (k6, service, Postgres) on one Windows laptop under Docker. Raw output is in `k6/`.

| Scenario | Throughput | p95 | Failures |
|---|---|---|---|
| 1 account (worst case, one lock) | about 87 to 120 req/s | 2.2 to 3.1 s | 0% |
| 20 accounts (realistic) | 196 req/s | 160 ms | 0% |

Correctness under load: in the 20-account run, total units consumed was 29935 = 5987 requests x 5 units, i.e. every request was counted exactly once.

Interpretation: all requests for one account queue on the same row lock, which is the deliberate price of never exceeding a limit. Throughput per account is therefore bounded, while different accounts proceed in parallel. The single-account run misses the p95 < 500 ms threshold; this is reported as measured, not tuned away.

Known improvements, not done: read user and plan data before taking the lock to shorten the critical section; compile to JavaScript instead of running through tsx; benchmark on dedicated hardware.

## Layout

```
service/   Fastify API, migrations, tests
client/    Demo client (CLI)
k6/        Load scripts and results
docker-compose.yml
