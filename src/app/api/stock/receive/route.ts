import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { receiveStockSchema } from "@/lib/validation/schemas";
import { handleUnknownError, jsonError } from "@/lib/api-helpers";

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return jsonError("Not authenticated", 401);
    }

    const body = receiveStockSchema.parse(await req.json());

    const { error } = await supabase.rpc("receive_stock", {
      p_product_id: body.product_id,
      p_warehouse_id: body.warehouse_id,
      p_quantity: body.quantity,
    });

    if (error) {
      throw error;
    }

    return NextResponse.json(
      {
        ok: true,
      },
      {
        status: 201,
      },
    );
  } catch (err) {
    return handleUnknownError(err);
  }
}