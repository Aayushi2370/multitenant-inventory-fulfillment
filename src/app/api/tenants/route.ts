import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { onboardTenantSchema } from "@/lib/validation/schemas";
import { handleUnknownError, jsonError } from "@/lib/api-helpers";

// POST /api/tenants
// Creates a new tenant for the authenticated user.
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return jsonError("Not authenticated", 401);
    }

    const body = onboardTenantSchema.parse(await req.json());

    const { data, error } = await supabase.rpc("onboard_tenant", {
      p_name: body.name,
      p_slug: body.slug,
    });

    if (error) {
      throw error;
    }

    return NextResponse.json(
      {
        tenant_id: data,
      },
      {
        status: 201,
      },
    );
  } catch (err) {
    return handleUnknownError(err);
  }
}