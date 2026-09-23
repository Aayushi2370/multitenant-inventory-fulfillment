import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { transferStockSchema } from "@/lib/validation/schemas";
import { handleUnknownError, jsonError } from "@/lib/api-helpers";

// GET /api/transfers
// Lists transfers belonging to the authenticated user's tenant.
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
      .from("transfers")
      .select("*")
      .order("created_at", {
        ascending: false,
      });

    if (error) {
      throw error;
    }

    return NextResponse.json({
      transfers: data,
    });
  } catch (err) {
    return handleUnknownError(err);
  }
}

// POST /api/transfers
//
// Moves stock between two warehouses belonging to the same tenant.
//
// The actual debit + credit + movement-history + transfer record
// operation is performed by the database function `transfer_stock()`.
//
// Because the complete operation happens inside one PostgreSQL
// transaction, a failure cannot leave the source warehouse debited
// without crediting the destination warehouse.
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return jsonError("Not authenticated", 401);
    }

    const body = transferStockSchema.parse(await req.json());

    const { data, error } = await supabase.rpc("transfer_stock", {
      p_product_id: body.product_id,
      p_from_warehouse_id: body.from_warehouse_id,
      p_to_warehouse_id: body.to_warehouse_id,
      p_quantity: body.quantity,
    });

    if (error) {
      throw error;
    }

    return NextResponse.json(
      {
        transfer_id: data,
      },
      {
        status: 201,
      },
    );
  } catch (err) {
    return handleUnknownError(err);
  }
}