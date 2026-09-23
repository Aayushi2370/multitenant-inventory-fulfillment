/**
 * "running the reconciliation job twice in a row must not create
 * duplicate flags or corrupt data."
 *
 * Run with: npx tsx tests/reconciliation-idempotency.ts
 * Requires NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: tenant, error: tErr } = await supabase
    .from("tenants")
    .insert({ name: "Idempotency Test Co", slug: `idempotency-test-${Date.now()}` })
    .select()
    .single();
  if (tErr) throw tErr;

  const { data: warehouse } = await supabase
    .from("warehouses")
    .insert({ tenant_id: tenant.id, name: "Main", code: "MAIN" })
    .select()
    .single();

  // low_stock_threshold 10, seed quantity below it → guarantees a low_stock flag.
  const { data: product } = await supabase
    .from("products")
    .insert({ tenant_id: tenant.id, sku: "LOW-1", name: "Low Stock Item", low_stock_threshold: 10 })
    .select()
    .single();

  await supabase
    .from("stock_levels")
    .insert({ tenant_id: tenant.id, product_id: product!.id, warehouse_id: warehouse!.id, quantity: 3 });
  // Deliberately record NO matching stock_movements row, so ledger_qty (0)
  // != balance_qty (3) → this also guarantees a drift flag.

  console.log("Running reconciliation, pass 1...");
  const { data: r1, error: e1 } = await supabase.rpc("run_reconciliation_for_tenant", {
    p_tenant_id: tenant.id,
  });
  if (e1) throw e1;
  console.log("Pass 1 result:", r1);

  const { data: flagsAfterFirst } = await supabase
    .from("reconciliation_flags")
    .select("*")
    .eq("tenant_id", tenant.id);
  const countAfterFirst = flagsAfterFirst?.length ?? 0;

  console.log("Running reconciliation, pass 2 (same day)...");
  const { data: r2, error: e2 } = await supabase.rpc("run_reconciliation_for_tenant", {
    p_tenant_id: tenant.id,
  });
  if (e2) throw e2;
  console.log("Pass 2 result:", r2);

  const { data: flagsAfterSecond } = await supabase
    .from("reconciliation_flags")
    .select("*")
    .eq("tenant_id", tenant.id);
  const countAfterSecond = flagsAfterSecond?.length ?? 0;

  console.log(`Flags after pass 1: ${countAfterFirst}, after pass 2: ${countAfterSecond}`);

  if (countAfterFirst !== countAfterSecond) {
    console.error("FAIL: row count changed between runs — duplicates were created.");
    process.exitCode = 1;
  } else if (countAfterFirst < 2) {
    console.error("FAIL: expected at least 2 flags (low_stock + drift) to be created.");
    process.exitCode = 1;
  } else {
    console.log("PASS: re-running reconciliation did not duplicate flags.");
  }

  await supabase.from("tenants").delete().eq("id", tenant.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
