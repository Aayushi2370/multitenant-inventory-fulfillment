/**
 * Concurrency test for the spec's core requirement:
 * "exactly one of the competing orders should succeed for the last unit."
 *
 * Run with: npx tsx tests/concurrency-oversell.ts
 * Requires two already-authenticated user sessions' cookies is overkill for
 * a script, so this test uses the service-role key directly against
 * fulfill_order() via supabase-js's .rpc(), which is a faithful stand-in
 * for N API requests hitting POST /api/orders at once — the atomicity
 * guarantee lives in the SQL function, not in the HTTP layer.
 *
 * Env required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from "@supabase/supabase-js";

const CONCURRENT_ORDERS = 10;
const STARTING_STOCK = 1; // only one unit exists — a true "last unit" race

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // --- Set up an isolated tenant/warehouse/product/stock for this run ---
  const { data: tenant, error: tErr } = await supabase
    .from("tenants")
    .insert({ name: "Concurrency Test Co", slug: `concurrency-test-${Date.now()}` })
    .select()
    .single();
  if (tErr) throw tErr;

  const { data: warehouse, error: wErr } = await supabase
    .from("warehouses")
    .insert({ tenant_id: tenant.id, name: "Main", code: "MAIN" })
    .select()
    .single();
  if (wErr) throw wErr;

  const { data: product, error: pErr } = await supabase
    .from("products")
    .insert({ tenant_id: tenant.id, sku: "RACE-1", name: "Race Item" })
    .select()
    .single();
  if (pErr) throw pErr;

  const { error: slErr } = await supabase
    .from("stock_levels")
    .insert({ tenant_id: tenant.id, product_id: product.id, warehouse_id: warehouse.id, quantity: STARTING_STOCK });
  if (slErr) throw slErr;

  console.log(`Set up tenant ${tenant.id}, product ${product.id}, stock=${STARTING_STOCK}`);
  console.log(`Firing ${CONCURRENT_ORDERS} concurrent orders for 1 unit each...`);

  // --- Fire N concurrent order attempts for the single unit ---
  const attempts = Array.from({ length: CONCURRENT_ORDERS }, () =>
    supabase.rpc("fulfill_order", {
      p_warehouse_id: warehouse.id,
      p_items: [{ product_id: product.id, quantity: 1 }],
    })
  );
  const results = await Promise.all(attempts);

  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  console.log(`Succeeded: ${succeeded.length}, Failed: ${failed.length}`);
  failed.forEach((f, i) => console.log(`  failure[${i}]: ${f.error?.message}`));

  if (succeeded.length !== 1) {
    console.error(`FAIL: expected exactly 1 success, got ${succeeded.length}`);
    process.exitCode = 1;
  } else {
    console.log("PASS: exactly one order succeeded for the last unit.");
  }

  // --- Verify final stock is 0, never negative ---
  const { data: finalStock } = await supabase
    .from("stock_levels")
    .select("quantity, reserved")
    .eq("product_id", product.id)
    .eq("warehouse_id", warehouse.id)
    .single();
  console.log(`Final stock_levels: quantity=${finalStock?.quantity}, reserved=${finalStock?.reserved}`);
  if (finalStock?.quantity !== 0) {
    console.error(`FAIL: expected final quantity 0, got ${finalStock?.quantity}`);
    process.exitCode = 1;
  }

  // --- Cleanup ---
  await supabase.from("tenants").delete().eq("id", tenant.id); // cascades
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
