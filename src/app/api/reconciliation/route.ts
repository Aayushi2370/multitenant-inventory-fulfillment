import { NextRequest, NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { jsonError } from "@/lib/api-helpers";

/**
 * GET /api/reconciliation
 *
 * Invoked by Vercel Cron or manually for testing.
 *
 * The route authenticates the caller using CRON_SECRET because the
 * service-role client bypasses RLS and is used to process every tenant.
 *
 * The database reconciliation function is idempotent, so running the
 * job repeatedly does not create duplicate flags.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return jsonError("Unauthorized", 401);
  }

  try {
    const supabase = createAdminClient();

    const {
      data: tenants,
      error: tenantsError,
    } = await supabase.from("tenants").select("id");

    if (tenantsError) {
      console.error(tenantsError);
      return jsonError("Failed to list tenants", 500);
    }

    const results: Array<
      | {
          tenant_id: string;
          low_stock_count: number;
          drift_count: number;
        }
      | {
          tenant_id: string;
          error: string;
        }
    > = [];

    for (const tenant of tenants ?? []) {
      const { data, error } = await supabase.rpc(
        "run_reconciliation_for_tenant",
        {
          p_tenant_id: tenant.id,
        },
      );

      if (error) {
        results.push({
          tenant_id: tenant.id,
          error: error.message,
        });

        continue;
      }

      const row = Array.isArray(data) ? data[0] : data;

      results.push({
        tenant_id: tenant.id,
        low_stock_count: row?.low_stock_count ?? 0,
        drift_count: row?.drift_count ?? 0,
      });
    }

    return NextResponse.json({
      ran_at: new Date().toISOString(),
      tenants: results,
    });
  } catch (error) {
    console.error(error);

    return jsonError("Reconciliation failed", 500);
  }
}