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
      .from("reconciliation_flags")
      .select("*")
      .order("created_at", {
        ascending: false,
      })
      .limit(100);

    if (error) {
      throw error;
    }

    return NextResponse.json({
      flags: data ?? [],
    });
  } catch (err) {
    return handleUnknownError(err);
  }
}

export async function POST() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return jsonError("Not authenticated", 401);
    }

    const { data, error } = await supabase.rpc(
      "run_reconciliation",
    );

    if (error) {
      throw error;
    }

    return NextResponse.json({
      result: data,
    });
  } catch (err) {
    return handleUnknownError(err);
  }
}