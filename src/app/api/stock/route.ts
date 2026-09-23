import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
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
      .from("stock_levels")
      .select(
        `
          *,
          products (
            id,
            sku,
            name,
            low_stock_threshold
          ),
          warehouses (
            id,
            name,
            code
          )
        `,
      )
      .order("updated_at", { ascending: false });

    if (error) {
      throw error;
    }

    return NextResponse.json({
      stock: data ?? [],
    });
  } catch (err) {
    return handleUnknownError(err);
  }
}