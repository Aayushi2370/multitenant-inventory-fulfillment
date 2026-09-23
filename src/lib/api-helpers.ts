import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function handleUnknownError(err: unknown) {
  if (err instanceof ZodError) {
    return jsonError(`Validation error: ${err.issues.map((i) => i.message).join("; ")}`, 400);
  }
  const message = err instanceof Error ? err.message : "Unknown error";

  // Postgres raises from our functions surface here as Error messages via
  // PostgREST/supabase-js. Map the ones the frontend should treat specially.
  if (message.startsWith("insufficient_stock") || message.toLowerCase().includes("insufficient stock")) {
    return jsonError(message, 409); // 409 Conflict — the client can retelry / show "insufficient stock"
  }
  if (message.toLowerCase().includes("not found")) {
    return jsonError(message, 404);
  }
  if (message.toLowerCase().includes("no tenant context") || message.toLowerCase().includes("already belongs")) {
    return jsonError(message, 403);
  }

  console.error(err);
  return jsonError(message, 400);
}
