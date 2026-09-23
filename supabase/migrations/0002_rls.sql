-- 0002_rls.sql
-- Row-Level Security: the DB itself refuses cross-tenant reads/writes,
-- regardless of what the application code's WHERE clause does or forgets.
--
-- Pattern for every tenant-owned table:
--   USING (tenant_id = current_tenant_id())        -- gates SELECT/UPDATE/DELETE visibility
--   WITH CHECK (tenant_id = current_tenant_id())    -- gates INSERT/UPDATE new-row values
--
-- current_tenant_id() (defined in 0001) looks up the caller's tenant from
-- user_profiles via auth.uid(), so it cannot be spoofed by request payload.

alter table tenants                enable row level security;
alter table user_profiles          enable row level security;
alter table warehouses             enable row level security;
alter table products               enable row level security;
alter table stock_levels           enable row level security;
alter table stock_movements        enable row level security;
alter table transfers              enable row level security;
alter table orders                 enable row level security;
alter table order_items            enable row level security;
alter table reconciliation_flags   enable row level security;

-- tenants: a user may only see their own tenant row (no listing all tenants).
-- Row is created via the onboarding function (security definer), not direct insert.
create policy tenants_select on tenants
  for select using (id = current_tenant_id());

-- user_profiles: users can see co-tenant profiles, not other tenants'.
create policy user_profiles_select on user_profiles
  for select using (tenant_id = current_tenant_id());

create policy user_profiles_update_self on user_profiles
  for update using (id = auth.uid()) with check (tenant_id = current_tenant_id());

-- Generic tenant-scoped CRUD policies -----------------------------------

create policy warehouses_all on warehouses
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy products_all on products
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy stock_levels_all on stock_levels
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy stock_movements_all on stock_movements
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy transfers_all on transfers
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy orders_all on orders
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy order_items_all on order_items
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

create policy reconciliation_flags_all on reconciliation_flags
  for all using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- Note: the atomic functions in 0003_functions.sql run as SECURITY DEFINER
-- so they can update stock_levels/stock_movements/orders/transfers across
-- the single statement's transaction, but each one independently re-derives
-- the caller's tenant_id via current_tenant_id() and filters/validates by it
-- before touching any row — RLS is the backstop, the function is the
-- fast, correct path.
