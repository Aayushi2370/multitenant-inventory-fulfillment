/**
 * Adversarial tenant-isolation test.
 * "try to fetch another tenant's data directly and confirm RLS blocks it"
 *
 * Run with: npx tsx tests/rls-adversarial.ts
 * Requires two real auth users already created (e.g. via Supabase Auth
 * sign-up), each onboarded to their OWN tenant. Set:
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY,
 *   TEST_USER_A_EMAIL, TEST_USER_A_PASSWORD,
 *   TEST_USER_B_EMAIL, TEST_USER_B_PASSWORD
 *
 * The test signs in as User A, then tries to read/write User B's
 * warehouse/product rows DIRECTLY (not through the app's own query
 * filters) — i.e. it queries by primary key with no tenant_id filter of
 * its own, which is exactly the "buggy WHERE clause" scenario RLS exists
 * to catch.
 */
import { createClient } from "@supabase/supabase-js";

async function signIn(email: string, password: string) {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function main() {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const clientA = await signIn(process.env.TEST_USER_A_EMAIL!, process.env.TEST_USER_A_PASSWORD!);
  const clientB = await signIn(process.env.TEST_USER_B_EMAIL!, process.env.TEST_USER_B_PASSWORD!);

  // B creates a warehouse and product in B's own tenant.
  const { data: bWarehouse, error: wErr } = await clientB
    .from("warehouses")
    .insert({ name: "B Secret Warehouse", code: "BSEC" })
    .select()
    .single();
  // Note: tenant_id is intentionally omitted here — RLS's WITH CHECK
  // combined with a default/trigger would normally set it, but since our
  // schema requires tenant_id explicitly, the app layer sets it from the
  // session. For this direct-DB adversarial test we insert via admin to
  // guarantee a real cross-tenant row exists to attack.
  let targetWarehouseId = bWarehouse?.id;
  if (wErr) {
    const { data: bProfile } = await admin
      .from("user_profiles")
      .select("tenant_id")
      .eq("email", process.env.TEST_USER_B_EMAIL!)
      .single();
    const { data: seeded } = await admin
      .from("warehouses")
      .insert({ tenant_id: bProfile!.tenant_id, name: "B Secret Warehouse", code: "BSEC" })
      .select()
      .single();
    targetWarehouseId = seeded!.id;
  }

  console.log(`Target (tenant B's) warehouse id: ${targetWarehouseId}`);

  // --- Attack 1: A tries to SELECT B's warehouse by primary key ---
  const { data: readAttempt } = await clientA
    .from("warehouses")
    .select("*")
    .eq("id", targetWarehouseId)
    .maybeSingle();

  if (readAttempt) {
    console.error("FAIL: User A was able to read User B's warehouse row!", readAttempt);
    process.exitCode = 1;
  } else {
    console.log("PASS: User A's SELECT for User B's warehouse returned no row.");
  }

  // --- Attack 2: A tries to UPDATE B's warehouse by primary key ---
  const { data: updateAttempt, error: updateErr } = await clientA
    .from("warehouses")
    .update({ name: "HACKED" })
    .eq("id", targetWarehouseId)
    .select();

  if ((updateAttempt && updateAttempt.length > 0) || (!updateErr && updateAttempt === null)) {
    console.error("FAIL: User A was able to update User B's warehouse row!", updateAttempt);
    process.exitCode = 1;
  } else {
    console.log("PASS: User A's UPDATE affected 0 rows of User B's warehouse.");
  }

  // --- Attack 3: A tries to INSERT a row explicitly tagged with B's tenant_id ---
  const { data: bProfile } = await admin
    .from("user_profiles")
    .select("tenant_id")
    .eq("email", process.env.TEST_USER_B_EMAIL!)
    .single();

  const { error: insertErr } = await clientA
    .from("warehouses")
    .insert({ tenant_id: bProfile!.tenant_id, name: "Injected", code: "INJ" });

  if (!insertErr) {
    console.error("FAIL: User A was able to insert a row under User B's tenant_id!");
    process.exitCode = 1;
  } else {
    console.log(`PASS: User A's cross-tenant INSERT was rejected (${insertErr.message}).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
