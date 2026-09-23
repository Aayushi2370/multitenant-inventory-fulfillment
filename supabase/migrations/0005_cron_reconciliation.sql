-- 0005_cron_reconciliation.sql
-- run_reconciliation() (0003) relies on current_tenant_id(), which reads
-- auth.uid() — that's correct for a logged-in user triggering a manual
-- reconciliation, but the Vercel Cron / Edge Function invocation has no
-- user session at all. This variant takes tenant_id explicitly and is
-- intended to be called ONLY by the service-role key from the trusted
-- cron route (never exposed to end users, never callable with a
-- caller-chosen tenant_id from client code).
create or replace function run_reconciliation_for_tenant(p_tenant_id uuid)
returns table(low_stock_count integer, drift_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_low_stock_count integer := 0;
  v_drift_count integer := 0;
begin
  with low as (
    select sl.tenant_id, sl.product_id, sl.warehouse_id, sl.quantity, p.low_stock_threshold
    from stock_levels sl
    join products p on p.id = sl.product_id
    where sl.tenant_id = p_tenant_id
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

  update reconciliation_flags rf
     set resolved = true, updated_at = now()
   where rf.tenant_id = p_tenant_id
     and rf.flag_type = 'low_stock'
     and rf.flag_date = current_date
     and rf.resolved = false
     and not exists (
       select 1 from stock_levels sl join products p on p.id = sl.product_id
       where sl.tenant_id = p_tenant_id
         and sl.product_id = rf.product_id
         and sl.warehouse_id = rf.warehouse_id
         and sl.quantity < p.low_stock_threshold
     );

  with ledger as (
    select tenant_id, product_id, warehouse_id, coalesce(sum(quantity_delta), 0) as ledger_qty
    from stock_movements
    where tenant_id = p_tenant_id
    group by tenant_id, product_id, warehouse_id
  ), mismatched as (
    select sl.tenant_id, sl.product_id, sl.warehouse_id,
           sl.quantity as balance_qty, l.ledger_qty
    from stock_levels sl
    join ledger l
      on l.tenant_id = sl.tenant_id and l.product_id = sl.product_id and l.warehouse_id = sl.warehouse_id
    where sl.tenant_id = p_tenant_id
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
   where rf.tenant_id = p_tenant_id
     and rf.flag_type = 'drift'
     and rf.flag_date = current_date
     and rf.resolved = false
     and not exists (
       select 1
       from stock_levels sl
       join (
         select tenant_id, product_id, warehouse_id, coalesce(sum(quantity_delta), 0) as ledger_qty
         from stock_movements where tenant_id = p_tenant_id
         group by tenant_id, product_id, warehouse_id
       ) l on l.tenant_id = sl.tenant_id and l.product_id = sl.product_id and l.warehouse_id = sl.warehouse_id
       where sl.tenant_id = p_tenant_id
         and sl.product_id = rf.product_id
         and sl.warehouse_id = rf.warehouse_id
         and sl.quantity <> l.ledger_qty
     );

  return query select v_low_stock_count, v_drift_count;
end;
$$;

-- Lock this down: only the service_role should ever call the _for_tenant
-- variant (it trusts its tenant_id argument completely, unlike the
-- session-derived run_reconciliation()).
revoke execute on function run_reconciliation_for_tenant(uuid) from public, authenticated, anon;
grant execute on function run_reconciliation_for_tenant(uuid) to service_role;
