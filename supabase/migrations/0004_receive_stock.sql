-- 0004_receive_stock.sql
-- receive_stock: inbound stock receipt (e.g. from a supplier). Not in the
-- brief's core flows, but needed so a warehouse can have stock at all
-- before transfers/orders are exercised. Same atomic-function discipline.
create or replace function receive_stock(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_quantity integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := current_tenant_id();
begin
  if v_tenant_id is null then
    raise exception 'No tenant context';
  end if;
  if p_quantity <= 0 then
    raise exception 'Quantity must be positive';
  end if;
  if not exists (select 1 from warehouses where id = p_warehouse_id and tenant_id = v_tenant_id)
     or not exists (select 1 from products where id = p_product_id and tenant_id = v_tenant_id) then
    raise exception 'Not found';
  end if;

  insert into stock_levels (tenant_id, product_id, warehouse_id, quantity)
    values (v_tenant_id, p_product_id, p_warehouse_id, p_quantity)
    on conflict (product_id, warehouse_id)
    do update set quantity = stock_levels.quantity + excluded.quantity, updated_at = now();

  insert into stock_movements
      (tenant_id, product_id, warehouse_id, quantity_delta, movement_type, created_by)
    values
      (v_tenant_id, p_product_id, p_warehouse_id, p_quantity, 'inbound', auth.uid());
end;
$$;
