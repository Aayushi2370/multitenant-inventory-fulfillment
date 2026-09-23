import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createProductSchema } from "@/lib/validation/schemas";
import { handleUnknownError, jsonError } from "@/lib/api-helpers";

export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return jsonError("Not authenticated", 401);
    }

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    return NextResponse.json({
      products: data ?? [],
    });
  } catch (err) {
    return handleUnknownError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return jsonError("Not authenticated", 401);
    }

    const body = createProductSchema.parse(await req.json());

    const { data: profile, error: profileError } = await supabase
      .from("user_profiles")
      .select("tenant_id")
      .eq("id", user.id)
      .single();

    if (profileError || !profile?.tenant_id) {
      return jsonError("No tenant context", 403);
    }

    const { data, error } = await supabase
      .from("products")
      .insert({
        tenant_id: profile.tenant_id,
        sku: body.sku,
        name: body.name,
        low_stock_threshold: body.low_stock_threshold,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return NextResponse.json(
      {
        product: data,
      },
      {
        status: 201,
      },
    );
  } catch (err) {
    return handleUnknownError(err);
  }
}