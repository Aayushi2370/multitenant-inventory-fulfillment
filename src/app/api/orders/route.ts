import { NextRequest, NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createOrderSchema } from "@/lib/validation/schemas";
import { handleUnknownError, jsonError } from "@/lib/api-helpers";

// GET /api/orders
// List orders with their order items for the authenticated user's tenant.
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
      .from("orders")
      .select("*, order_items(*)")
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    return NextResponse.json({
      orders: data,
    });
  } catch (err) {
    return handleUnknownError(err);
  }
}

// POST /api/orders
//
// Create an order and atomically reserve stock for every line item.
//
// IMPORTANT:
// The stock check and reservation are NOT performed separately here.
//
// The actual atomic reservation happens inside the database function
// `fulfill_order()` created in 0003_functions.sql.
//
// This prevents the race condition where two concurrent requests both
// read the same available stock before either request updates it.
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return jsonError("Not authenticated", 401);
    }

    const body = createOrderSchema.parse(await req.json());

    const { data, error } = await supabase.rpc("fulfill_order", {
      p_warehouse_id: body.warehouse_id,
      p_items: body.items,
    });

    if (error) {
      throw error;
    }

    return NextResponse.json(
      {
        order_id: data,
      },
      {
        status: 201,
      },
    );
  } catch (err) {
    return handleUnknownError(err);
  }
}