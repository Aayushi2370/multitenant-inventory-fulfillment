import { z } from "zod";

// Never trust client input server-side.
// Every route must parse input through one of these schemas
// before touching the database.

export const onboardTenantSchema = z.object({
  name: z.string().min(2).max(100),

  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-z0-9-]+$/,
      "slug must be lowercase letters, numbers, hyphens",
    ),
});

export const createWarehouseSchema = z.object({
  name: z.string().min(1).max(100),
  code: z.string().min(1).max(20),
});

export const createProductSchema = z.object({
  sku: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  low_stock_threshold: z.number().int().min(0).default(10),
});

export const receiveStockSchema = z.object({
  product_id: z.string().uuid(),
  warehouse_id: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const transferStockSchema = z.object({
  product_id: z.string().uuid(),
  from_warehouse_id: z.string().uuid(),
  to_warehouse_id: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const orderItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const createOrderSchema = z.object({
  warehouse_id: z.string().uuid(),
  items: z.array(orderItemSchema).min(1).max(100),
});