# Multi-Tenant Inventory & Order Fulfillment (Prototype)

Internal ops tool: multiple tenants, multiple warehouses per tenant, safe
concurrent order fulfillment. No external APIs, no billing, no storefront —
per spec, the depth is in tenant isolation and concurrency correctness.

## Stack

- Next.js 16.2 (App Router) + TypeScript 6.0.3
- Node.js 24
- Tailwind CSS v4
- Zod 4.4.3 for all API-boundary validation
- Supabase (Postgres 17) for DB, Auth, and RLS
- Vercel for hosting + Vercel Cron for the reconciliation sweep

## Project layout

```
supabase/migrations/    SQL: schema, RLS policies, atomic functions
src/app/api/            Next.js Route Handlers (thin — validate, call DB)
src/app/                UI (login, onboarding, dashboard)
src/lib/                Supabase clients, Zod schemas, error helpers
tests/                  Standalone scripts for the three required tests
```

## Local setup

```bash
npm install
supabase init                # if not already
supabase link --project-ref YOUR_PROJECT_REF
supabase db push             # runs migrations 0001–0005 in order
cp .env.local.example .env.local   # fill in your Supabase URL/keys
npm run dev
```

Sign up a user via the `/login` magic-link flow, then you'll land on
`/onboarding` to create your tenant (no billing step).

---

## How tenant isolation is enforced (the README's required answer #1)

Isolation is enforced **at the database layer with Postgres Row-Level
Security**, not by the application remembering to add `WHERE tenant_id = ...`
to every query. Concretely:

1. Every tenant-owned table (`warehouses`, `products`, `stock_levels`,
   `stock_movements`, `transfers`, `orders`, `order_items`,
   `reconciliation_flags`) has a `tenant_id` column and `ENABLE ROW LEVEL
   SECURITY` (`supabase/migrations/0002_rls.sql`).
2. A `current_tenant_id()` SQL function looks up the **caller's** tenant
   from `user_profiles` via `auth.uid()` — the session's JWT, not anything
   the client sent in the request body. It's `SECURITY DEFINER` with a
   pinned `search_path` so it works even though `user_profiles` itself has
   RLS enabled.
3. Every policy is `USING (tenant_id = current_tenant_id()) WITH CHECK
   (tenant_id = current_tenant_id())` — this gates `SELECT`/`UPDATE`/`DELETE`
   visibility **and** blocks `INSERT`/`UPDATE` from writing a row under any
   other tenant's id.
4. API routes use the **anon key** through a cookie-scoped server client
   (`src/lib/supabase/server.ts`), so every query they run is subject to
   RLS as the logged-in user — there is no code path in the app that reads
   with elevated privileges. (The one exception, the cron sweep, is called
   out below.)

Because the boundary lives in Postgres, a bug in a route's query — say,
forgetting a filter, or an attacker hitting `/rest/v1/warehouses?id=eq.<some
other tenant's id>` directly — cannot leak another tenant's rows: Postgres
itself refuses to return or modify them.

**Adversarial test** (`tests/rls-adversarial.ts`): signs in as two real
users in two different tenants, then has user A try to `SELECT`, `UPDATE`,
and `INSERT` directly against user B's `warehouses` row by primary key —
i.e. exactly the "buggy WHERE clause" scenario RLS exists to catch. All
three attempts are expected to affect zero rows.

The one place RLS is intentionally bypassed is the **reconciliation cron**
(`src/app/api/reconciliation/route.ts`), which uses the **service-role**
key because it must sweep every tenant in one run. It has no user session
to derive a tenant from, so it (a) is gated by its own `CRON_SECRET`
bearer-token check, and (b) calls a separate function,
`run_reconciliation_for_tenant(tenant_id)`, whose `EXECUTE` grant is
revoked from `anon`/`authenticated` and given only to `service_role` — it
can never be invoked by a browser session with an attacker-chosen
`tenant_id`.

---

## What prevents overselling on the last unit (the README's required answer #2)

The short version: **a single conditional `UPDATE` statement, inside one
Postgres function, is the entire race-safety mechanism** — there is no
"check stock, then write" gap for two requests to land in.

`fulfill_order()` (`supabase/migrations/0003_functions.sql`) does, per
line item:

```sql
update stock_levels
   set quantity = quantity - v_quantity,
       reserved = reserved + v_quantity
 where product_id = v_product_id
   and warehouse_id = p_warehouse_id
   and tenant_id = v_tenant_id
   and quantity >= v_quantity;         -- the atomicity guard
get diagnostics v_rows = row_count;

if v_rows = 0 then
  raise exception 'insufficient_stock: ...';   -- rolls back the WHOLE order
end if;
```

Why this is race-safe under real concurrency, not just "usually fine":

- An `UPDATE ... WHERE` in Postgres takes a **row lock** on the matched
  row for the duration of the statement. If two transactions try to
  update the same `stock_levels` row at once, the second one **blocks**
  until the first commits or rolls back — it does not read stale data.
- Once the first transaction commits, the second transaction's `WHERE
  quantity >= v_quantity` is re-evaluated against the **now-updated**
  row. For a last-unit race, that re-check fails, `row_count = 0`, and
  the function `raise exception`s.
- The `raise exception` aborts the **entire `fulfill_order()` call** —
  Postgres rolls back the whole implicit transaction, so the `orders` row,
  the `order_items` row, and any earlier line items already reserved in
  that same call are all undone. The losing request gets a clean 409
  `insufficient_stock` error from the API (`src/lib/api-helpers.ts` maps
  it), with **no partial order** left behind.
- There is exactly one statement doing the check-and-decrement — no
  separate `SELECT` to inspect stock followed by a later `UPDATE`/`INSERT`,
  which is the classic TOCTOU (time-of-check-to-time-of-use) bug the spec
  calls out.

**Concurrency test** (`tests/concurrency-oversell.ts`): seeds a product
with exactly **1** unit of stock in one warehouse, then fires **10**
simultaneous `fulfill_order()` calls each requesting 1 unit. The test
asserts exactly 1 succeeds, the other 9 fail with `insufficient_stock`,
and the final `stock_levels.quantity` is `0` (never negative).

The same pattern — one conditional `UPDATE`, checked by `row_count`,
inside a function whose failure rolls back everything — is used for
warehouse transfers (`transfer_stock()`), so a transfer can never debit
the source warehouse without crediting the destination: either both
`stock_movements` legs and both balance updates commit, or none of them
do.

---

## Reconciliation sweep & idempotency

`run_reconciliation_for_tenant()` (called by Vercel Cron, see
`vercel.json` + `src/app/api/reconciliation/route.ts`) checks, per tenant:

- **Low stock**: any `stock_levels` row under its product's
  `low_stock_threshold`.
- **Drift**: `stock_levels.quantity + reserved` should always equal the
  `SUM(quantity_delta)` of that product+warehouse's `stock_movements`
  ledger — that ledger is the source of truth. A mismatch means the
  cached balance and the append-only history disagree.

Both checks **UPSERT** into `reconciliation_flags` on the unique key
`(tenant_id, product_id, warehouse_id, flag_type, flag_date)`. Running the
sweep twice on the same day updates the same rows (refreshing `details`
and `updated_at`) instead of inserting duplicates, and a flag that no
longer applies is marked `resolved = true` rather than left stale.

**Idempotency test** (`tests/reconciliation-idempotency.ts`): seeds a
tenant with a guaranteed low-stock condition and a guaranteed drift
(stock recorded with no matching movement row), runs the sweep twice, and
asserts the flag row count is identical after both runs.

---

## Running the three required tests

```bash
# .env with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (+ two
# test user credentials for the RLS test — see each file's header comment)
npx tsx tests/rls-adversarial.ts
npx tsx tests/concurrency-oversell.ts
npx tsx tests/reconciliation-idempotency.ts
```

Each script sets up its own isolated tenant/data and cleans up after
itself (`tenants` cascades to everything else on delete).

## What I'd build next with another week

1. **Per-line-item warehouse support in orders** — the schema allows it
   (`order_items` doesn't force a single warehouse) but `fulfill_order()`
   currently takes one `warehouse_id` for the whole order; splitting a
   single order across warehouses would need the function to accept
   `warehouse_id` per line.
2. **Order cancellation / release** — a `release_order()` function
   symmetric to `fulfill_order()` that returns reserved stock to
   `stock_levels` and writes an `order_release` movement, for when an
   order is cancelled after confirmation.
3. **Real-time dashboard updates** via Supabase Realtime subscriptions on
   `stock_levels` and `reconciliation_flags`, instead of the current
   fetch-on-load pattern.
4. **Pagination + filtering** on orders/transfers list endpoints — fine
   for a prototype, not for a tenant with thousands of orders.
5. **Structured audit log** for who changed what (the `created_by` columns
   exist but there's no UI surfacing them yet), and a proper `owner`/
   `member` permission split (right now any tenant member can do
   everything).
6. **Automated integration tests** wired into CI (the three scripts in
   `tests/` are currently run manually) using a scratch Supabase project
   per CI run.
