-- 0001_schema.sql
-- Core multi-tenant schema.
-- Every tenant-owned table carries tenant_id,
-- which RLS policies (0002_rls.sql) key off of.

-- gen_random_uuid() is available in Supabase/Postgres.
-- No uuid-ossp extension is required.

-- ─────────────────────────────────────────────────────────────────────────
-- Tenants
-- ─────────────────────────────────────────────────────────────────────────

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Users
-- One row per auth.users row, tenant-scoped.
-- A user belongs to exactly one tenant.
-- ─────────────────────────────────────────────────────────────────────────

create table user_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  email       text not null,
  role        text not null default 'member'
              check (role in ('owner', 'member')),
  created_at  timestamptz not null default now()
);

create index idx_user_profiles_tenant
  on user_profiles(tenant_id);

-- Helper used by RLS policies.
-- Returns the tenant_id of the currently authenticated user.

create or replace function current_tenant_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select tenant_id
  from user_profiles
  where id = auth.uid();
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Warehouses
-- ─────────────────────────────────────────────────────────────────────────

create table warehouses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  code        text not null,
  created_at  timestamptz not null default now(),

  unique (tenant_id, code)
);

create index idx_warehouses_tenant
  on warehouses(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Products
-- ─────────────────────────────────────────────────────────────────────────

create table products (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  sku                 text not null,
  name                text not null,
  low_stock_threshold integer not null default 10,
  created_at          timestamptz not null default now(),

  unique (tenant_id, sku)
);

create index idx_products_tenant
  on products(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Stock per product per warehouse
-- ─────────────────────────────────────────────────────────────────────────

create table stock_levels (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  warehouse_id  uuid not null references warehouses(id) on delete cascade,
  quantity      integer not null default 0
                check (quantity >= 0),
  reserved      integer not null default 0
                check (reserved >= 0),
  updated_at    timestamptz not null default now(),

  primary key (product_id, warehouse_id)
);

create index idx_stock_levels_tenant
  on stock_levels(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Stock movements
-- Append-only inventory ledger.
-- ─────────────────────────────────────────────────────────────────────────

create table stock_movements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  product_id      uuid not null references products(id) on delete cascade,
  warehouse_id    uuid not null references warehouses(id) on delete cascade,
  quantity_delta  integer not null,

  movement_type   text not null check (
    movement_type in (
      'inbound',
      'outbound',
      'transfer_out',
      'transfer_in',
      'order_reserve',
      'order_release',
      'adjustment'
    )
  ),

  reference_type  text,
  reference_id    uuid,

  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id)
);

create index idx_stock_movements_tenant
  on stock_movements(tenant_id);

create index idx_stock_movements_product_wh
  on stock_movements(product_id, warehouse_id);

create index idx_stock_movements_reference
  on stock_movements(reference_type, reference_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Transfers
-- One transfer record represents the complete warehouse-to-warehouse move.
-- ─────────────────────────────────────────────────────────────────────────

create table transfers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  product_id          uuid not null references products(id) on delete cascade,
  from_warehouse_id   uuid not null references warehouses(id),
  to_warehouse_id     uuid not null references warehouses(id),
  quantity            integer not null check (quantity > 0),

  status              text not null default 'completed'
                      check (status in ('completed', 'failed')),

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),

  check (from_warehouse_id <> to_warehouse_id)
);

create index idx_transfers_tenant
  on transfers(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Orders
-- ─────────────────────────────────────────────────────────────────────────

create table orders (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  warehouse_id  uuid not null references warehouses(id),
  status        text not null default 'confirmed'
                check (status in ('confirmed', 'cancelled')),
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
);

create index idx_orders_tenant
  on orders(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Order items
-- ─────────────────────────────────────────────────────────────────────────

create table order_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  order_id    uuid not null references orders(id) on delete cascade,
  product_id  uuid not null references products(id),
  quantity    integer not null check (quantity > 0)
);

create index idx_order_items_tenant
  on order_items(tenant_id);

create index idx_order_items_order
  on order_items(order_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Reconciliation flags
-- ─────────────────────────────────────────────────────────────────────────

create table reconciliation_flags (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  warehouse_id  uuid references warehouses(id),

  flag_type     text not null check (
    flag_type in ('low_stock', 'drift')
  ),

  flag_date     date not null default current_date,

  details       jsonb not null default '{}',

  resolved      boolean not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (
    tenant_id,
    product_id,
    warehouse_id,
    flag_type,
    flag_date
  )
);

create index idx_reconciliation_flags_tenant
  on reconciliation_flags(tenant_id);