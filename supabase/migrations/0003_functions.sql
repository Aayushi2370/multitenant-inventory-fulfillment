-- 0003_functions.sql
-- All write paths that must be atomic/race-safe are implemented as single
-- Postgres functions (SECURITY DEFINER), never as "check in app code, then
-- write" across two round trips. Each function runs inside one implicit
-- transaction; any exception rolls the whole thing back.

-- ─────────────────────────────────────────────────────────────────────────
-- onboard_tenant: create-tenant flow. No billing, just a name + the
-- calling auth user becomes the first ('owner') user of the new tenant.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function onboard_tenant(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if exists (select 1 from user_profiles where id = auth.uid()) then
    raise exception 'User already belongs to a tenant';
  end if;

  insert into tenants (name, slug) values (p_name, p_slug)
    returning id into v_tenant_id;

  insert into user_profiles (id, tenant_id, email, role)
    values (auth.uid(), v_tenant_id, auth.email(), 'owner');

  return v_tenant_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- transfer_stock: warehouse-to-warehouse move as ONE transfers row plus
-- its two linked stock_movements legs (transfer_out / transfer_in), all
-- committed together. If the debit can't be satisfied, the whole function
-- raises and nothing is written — never a debit stranded without its credit.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function transfer_stock(
  p_product_id uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid,
  p_quantity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_transfer_id uuid;
  v_rows integer;
begin
  if v_tenant_id is null then
    raise exception 'No tenant context';
  end if;
  if p_quantity <= 0 then
    raise exception 'Quantity must be positive';
  end if;
  if p_from_warehouse_id = p_to_warehouse_id then
    raise exception 'Source and destination warehouse must differ';
  end if;

  -- Ownership check: both warehouses and the product must belong to caller's tenant.
  if not exists (select 1 from warehouses where id = p_from_warehouse_id and tenant_id = v_tenant_id)
     or not exists (select 1 from warehouses where id = p_to_warehouse_id and tenant_id = v_tenant_id)
     or not exists (select 1 from products where id = p_product_id and tenant_id = v_tenant_id) then
    raise exception 'Not found';
  end if;

  insert into transfers (tenant_id, product_id, from_warehouse_id, to_warehouse_id, quantity, created_by)
    values (v_tenant_id, p_product_id, p_from_warehouse_id, p_to_warehouse_id, p_quantity, auth.uid())
    returning id into v_transfer_id;

  -- Conditional debit: the WHERE clause is the atomicity guard. Postgres
  -- takes a row lock on the matched stock_levels row for the duration of
  -- this UPDATE, so a concurrent transfer/order on the same row queues
  -- behind it rather than racing it.
  update stock_levels
     set quantity = quantity - p_quantity, updated_at = now()
   where product_id = p_product_id
     and warehouse_id = p_from_warehouse_id
     and tenant_id = v_tenant_id
     and quantity >= p_quantity;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception 'Insufficient stock in source warehouse';
  end if;

  insert into stock_levels (tenant_id, product_id, warehouse_id, quantity)
    values (v_tenant_id, p_product_id, p_to_warehouse_id, p_quantity)
    on conflict (product_id, warehouse_id)
    do update set quantity = stock_levels.quantity + excluded.quantity, updated_at = now();

  insert into stock_movements
      (tenant_id, product_id, warehouse_id, quantity_delta, movement_type, reference_type, reference_id, created_by)
    values
      (v_tenant_id, p_product_id, p_from_warehouse_id, -p_quantity, 'transfer_out', 'transfer', v_transfer_id, auth.uid());

  insert into stock_movements
      (tenant_id, product_id, warehouse_id, quantity_delta, movement_type, reference_type, reference_id, created_by)
    values
      (v_tenant_id, p_product_id, p_to_warehouse_id, p_quantity, 'transfer_in', 'transfer', v_transfer_id, auth.uid());

  return v_transfer_id;
  -- Any exception above aborts the whole function's transaction: the
  -- transfers row, the debit, the credit and both movement rows are
  -- either all committed or none are. There is no state where stock has
  -- left the source warehouse without a matching credit.
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- fulfill_order: creates an order + its items and reserves stock for each
-- line item atomically. p_items is a jsonb array: [{"product_id": "...",
-- "warehouse_id": "...", "quantity": N}, ...] (warehouse_id may vary per
-- line item, but typically one order = one warehouse from the app layer).
--
-- Race-safety: each line's stock debit is a single conditional UPDATE
-- (quantity >= requested) whose row lock serializes concurrent competing
-- orders on that same product+warehouse. Under N simultaneous requests for
-- the last unit, exactly one UPDATE's WHERE clause matches; the rest see
-- row_count = 0 and raise, rolling back that whole order (no order row,
-- no reservation, nothing partially applied) so the caller gets a clean
-- "insufficient stock" error.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function fulfill_order(p_warehouse_id uuid, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_order_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_rows integer;
begin
  if v_tenant_id is null then
    raise exception 'No tenant context';
  end if;
  if not exists (select 1 from warehouses where id = p_warehouse_id and tenant_id = v_tenant_id) then
    raise exception 'Warehouse not found';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'Order must have at least one item';
  end if;

  insert into orders (tenant_id, warehouse_id, status, created_by)
    values (v_tenant_id, p_warehouse_id, 'confirmed', auth.uid())
    returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_quantity   := (v_item ->> 'quantity')::integer;

    if v_quantity <= 0 then
      raise exception 'Quantity must be positive for product %', v_product_id;
    end if;
    if not exists (select 1 from products where id = v_product_id and tenant_id = v_tenant_id) then
      raise exception 'Product % not found', v_product_id;
    end if;

    insert into order_items (tenant_id, order_id, product_id, quantity)
      values (v_tenant_id, v_order_id, v_product_id, v_quantity);

    -- The atomic reservation: this is the statement that prevents overselling.
    update stock_levels
       set quantity = quantity - v_quantity,
           reserved = reserved + v_quantity,
           updated_at = now()
     where product_id = v_product_id
       and warehouse_id = p_warehouse_id
       and tenant_id = v_tenant_id
       and quantity >= v_quantity;
    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      -- Raising here aborts the ENTIRE function (the order insert and any
      -- earlier line items in this same order too) — Postgres rolls back
      -- the whole transaction, so a partially-reserved order never exists.
      raise exception 'insufficient_stock: product % has fewer than % units available', v_product_id, v_quantity;
    end if;

    insert into stock_movements
        (tenant_id, product_id, warehouse_id, quantity_delta, movement_type, reference_type, reference_id, created_by)
      values
        (v_tenant_id, v_product_id, p_warehouse_id, -v_quantity, 'order_reserve', 'order', v_order_id, auth.uid());
  end loop;

  return v_order_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- run_reconciliation: scheduled sweep for the caller's tenant. Flags:
--   (a) low_stock  — stock_levels.quantity below the product's threshold
--   (b) drift      — stock_levels.quantity doesn't match the sum of that
--                     product+warehouse's stock_movements (ground truth)
--
-- Idempotency: every flag is UPSERTed on the unique key
-- (tenant_id, product_id, warehouse_id, flag_type, flag_date), so running
-- this twice in the same day updates the same rows (refreshing `details`
-- and `updated_at`) instead of inserting duplicates. A flag that no longer
-- applies (fixed since the last run) is marked resolved rather than left
-- stale, so the flag set always reflects current reality.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function run_reconciliation()
returns table(low_stock_count integer, drift_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
  v_low_stock_count integer := 0;
  v_drift_count integer := 0;
begin
  if v_tenant_id is null then
    raise exception 'No tenant context';
  end if;

  -- (a) Low stock: flag any stock_levels row under its product's threshold.
  with low as (
    select sl.tenant_id, sl.product_id, sl.warehouse_id, sl.quantity, p.low_stock_threshold
    from stock_levels sl
    join products p on p.id = sl.product_id
    where sl.tenant_id = v_tenant_id
      and sl.quantity < p.low_stock_threshold
  ), upserted as (
    insert into reconciliation_flags (tenant_id, product_id, warehouse_id, flag_type, flag_date, details, resolved)
    select tenant_id, product_id, warehouse_id, 'low_stock', current_date,
           jsonb_build_object('quantity', quantity, 'threshold', low_stock_threshold), false
    from low
    on conflict (tenant_id, product_id, warehouse_id, flag_type, flag_date)
    do update set details = excluded.details, resolved = false, updated_at = now()
    returning 1
  )
  select count(*) into v_low_stock_count from upserted;

  -- Resolve low_stock flags from today that no longer meet the condition.
  update reconciliation_flags rf
     set resolved = true, updated_at = now()
   where rf.tenant_id = v_tenant_id
     and rf.flag_type = 'low_stock'
     and rf.flag_date = current_date
     and rf.resolved = false
     and not exists (
       select 1 from stock_levels sl join products p on p.id = sl.product_id
       where sl.tenant_id = v_tenant_id
         and sl.product_id = rf.product_id
         and sl.warehouse_id = rf.warehouse_id
         and sl.quantity < p.low_stock_threshold
     );

  -- (b) Drift: stock_levels.quantity should equal the append-only movement
  -- ledger for the available balance. Reservation movements are negative
  -- because they reduce available stock and increase `reserved`; comparing
  -- quantity+reserved to this ledger would falsely flag valid reservations.
  with ledger as (
    select tenant_id, product_id, warehouse_id, coalesce(sum(quantity_delta), 0) as ledger_qty
    from stock_movements
    where tenant_id = v_tenant_id
    group by tenant_id, product_id, warehouse_id
  ), mismatched as (
    select sl.tenant_id, sl.product_id, sl.warehouse_id,
           sl.quantity as balance_qty, l.ledger_qty
    from stock_levels sl
    join ledger l
      on l.tenant_id = sl.tenant_id and l.product_id = sl.product_id and l.warehouse_id = sl.warehouse_id
    where sl.tenant_id = v_tenant_id
      and sl.quantity <> l.ledger_qty
  ), upserted2 as (
    insert into reconciliation_flags (tenant_id, product_id, warehouse_id, flag_type, flag_date, details, resolved)
    select tenant_id, product_id, warehouse_id, 'drift', current_date,
           jsonb_build_object('balance_qty', balance_qty, 'ledger_qty', ledger_qty), false
    from mismatched
    on conflict (tenant_id, product_id, warehouse_id, flag_type, flag_date)
    do update set details = excluded.details, resolved = false, updated_at = now()
    returning 1
  )
  select count(*) into v_drift_count from upserted2;

  update reconciliation_flags rf
     set resolved = true, updated_at = now()
   where rf.tenant_id = v_tenant_id
     and rf.flag_type = 'drift'
     and rf.flag_date = current_date
     and rf.resolved = false
     and not exists (
       select 1
       from stock_levels sl
       join (
         select tenant_id, product_id, warehouse_id, coalesce(sum(quantity_delta), 0) as ledger_qty
         from stock_movements where tenant_id = v_tenant_id
         group by tenant_id, product_id, warehouse_id
       ) l on l.tenant_id = sl.tenant_id and l.product_id = sl.product_id and l.warehouse_id = sl.warehouse_id
       where sl.tenant_id = v_tenant_id
         and sl.product_id = rf.product_id
         and sl.warehouse_id = rf.warehouse_id
         and sl.quantity <> l.ledger_qty
     );

  return query select v_low_stock_count, v_drift_count;
end;
$$;
