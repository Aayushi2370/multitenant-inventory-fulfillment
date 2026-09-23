import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client.
 *
 * This BYPASSES RLS, so it must only ever be used server-side,
 * and only for the reconciliation cron path, where there is
 * no logged-in user/cookie session to run `run_reconciliation()`
 * as.
 *
 * The cron route authenticates the caller via CRON_SECRET before
 * this client is used, and the route loops over tenants explicitly
 * rather than trusting any client-supplied tenant_id.
 */
export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured");
  }

  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });
}