"use client";

import { useEffect, useState, useCallback } from "react";

type Warehouse = { id: string; name: string; code: string };
type Product = { id: string; sku: string; name: string; low_stock_threshold: number };
type Transfer = {
  id: string;
  product_id: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  quantity: number;
  created_at: string;
};
type Order = {
  id: string;
  warehouse_id: string;
  status: string;
  created_at: string;
  order_items: { product_id: string; quantity: number }[];
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

export default function Dashboard() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [w, p, t, o] = await Promise.all([
        api<{ warehouses: Warehouse[] }>("/api/warehouses"),
        api<{ products: Product[] }>("/api/products"),
        api<{ transfers: Transfer[] }>("/api/transfers"),
        api<{ orders: Order[] }>("/api/orders"),
      ]);
      setWarehouses(w.warehouses);
      setProducts(p.products);
      setTransfers(t.transfers);
      setOrders(o.orders);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function withFeedback(fn: () => Promise<void>) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage("Done.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  function fd(form: HTMLFormElement) {
    return Object.fromEntries(new FormData(form).entries());
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold">Inventory & Fulfillment</h1>
      <p className="mb-6 text-sm text-neutral-600">Internal ops tool — multi-tenant, RLS-isolated.</p>

      {message && <p className="mb-4 rounded bg-green-50 px-3 py-2 text-sm text-green-800">{message}</p>}
      {error && <p className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}

      <section className="mb-8 grid gap-6 sm:grid-cols-2">
        <Card title="Warehouses">
          <ul className="mb-3 space-y-1 text-sm">
            {warehouses.map((w) => (
              <li key={w.id}>
                <span className="font-mono text-xs text-neutral-500">{w.code}</span> {w.name}
              </li>
            ))}
            {warehouses.length === 0 && <li className="text-neutral-400">None yet</li>}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = fd(e.currentTarget);
              withFeedback(() => api("/api/warehouses", { method: "POST", body: JSON.stringify(data) }));
              e.currentTarget.reset();
            }}
          >
            <input name="name" placeholder="Name" required className="w-1/2 rounded border px-2 py-1 text-sm" />
            <input name="code" placeholder="Code" required className="w-1/3 rounded border px-2 py-1 text-sm" />
            <button className="rounded bg-neutral-900 px-2 py-1 text-sm text-white">Add</button>
          </form>
        </Card>

        <Card title="Products">
          <ul className="mb-3 space-y-1 text-sm">
            {products.map((p) => (
              <li key={p.id}>
                <span className="font-mono text-xs text-neutral-500">{p.sku}</span> {p.name}{" "}
                <span className="text-neutral-400">(threshold {p.low_stock_threshold})</span>
              </li>
            ))}
            {products.length === 0 && <li className="text-neutral-400">None yet</li>}
          </ul>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = fd(e.currentTarget) as Record<string, string>;
              withFeedback(() =>
                api("/api/products", {
                  method: "POST",
                  body: JSON.stringify({
                    sku: data.sku,
                    name: data.name,
                    low_stock_threshold: Number(data.low_stock_threshold || 10),
                  }),
                })
              );
              e.currentTarget.reset();
            }}
          >
            <input name="sku" placeholder="SKU" required className="w-1/4 rounded border px-2 py-1 text-sm" />
            <input name="name" placeholder="Name" required className="w-1/3 rounded border px-2 py-1 text-sm" />
            <input
              name="low_stock_threshold"
              placeholder="Threshold"
              type="number"
              className="w-1/4 rounded border px-2 py-1 text-sm"
            />
            <button className="rounded bg-neutral-900 px-2 py-1 text-sm text-white">Add</button>
          </form>
        </Card>
      </section>

      <section className="mb-8 grid gap-6 sm:grid-cols-2">
        <Card title="Receive stock (inbound)">
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = fd(e.currentTarget) as Record<string, string>;
              withFeedback(() =>
                api("/api/stock/receive", {
                  method: "POST",
                  body: JSON.stringify({
                    product_id: data.product_id,
                    warehouse_id: data.warehouse_id,
                    quantity: Number(data.quantity),
                  }),
                })
              );
              e.currentTarget.reset();
            }}
          >
            <ProductSelect products={products} />
            <WarehouseSelect warehouses={warehouses} />
            <input name="quantity" type="number" min={1} placeholder="Quantity" required className="rounded border px-2 py-1 text-sm" />
            <button className="rounded bg-neutral-900 px-2 py-1 text-sm text-white">Receive</button>
          </form>
        </Card>

        <Card title="Transfer between warehouses">
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = fd(e.currentTarget) as Record<string, string>;
              withFeedback(() =>
                api("/api/transfers", {
                  method: "POST",
                  body: JSON.stringify({
                    product_id: data.product_id,
                    from_warehouse_id: data.from_warehouse_id,
                    to_warehouse_id: data.to_warehouse_id,
                    quantity: Number(data.quantity),
                  }),
                })
              );
              e.currentTarget.reset();
            }}
          >
            <ProductSelect products={products} />
            <WarehouseSelect warehouses={warehouses} name="from_warehouse_id" label="From" />
            <WarehouseSelect warehouses={warehouses} name="to_warehouse_id" label="To" />
            <input name="quantity" type="number" min={1} placeholder="Quantity" required className="rounded border px-2 py-1 text-sm" />
            <button className="rounded bg-neutral-900 px-2 py-1 text-sm text-white">Transfer</button>
          </form>
          <ul className="mt-3 space-y-1 text-xs text-neutral-500">
            {transfers.slice(0, 5).map((t) => (
              <li key={t.id}>
                {t.quantity} units, {new Date(t.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section className="mb-8">
        <Card title="Create order (atomic reservation)">
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const data = fd(e.currentTarget) as Record<string, string>;
              withFeedback(() =>
                api("/api/orders", {
                  method: "POST",
                  body: JSON.stringify({
                    warehouse_id: data.warehouse_id,
                    items: [{ product_id: data.product_id, quantity: Number(data.quantity) }],
                  }),
                })
              );
              e.currentTarget.reset();
            }}
          >
            <WarehouseSelect warehouses={warehouses} />
            <ProductSelect products={products} />
            <input name="quantity" type="number" min={1} placeholder="Qty" required className="rounded border px-2 py-1 text-sm" />
            <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">Place order</button>
          </form>
          <ul className="mt-3 space-y-1 text-xs text-neutral-500">
            {orders.slice(0, 5).map((o) => (
              <li key={o.id}>
                {o.status} — {o.order_items.length} item(s) — {new Date(o.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <ReconciliationPanel />
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-neutral-800">{title}</h2>
      {children}
    </div>
  );
}

function ProductSelect({ products }: { products: Product[] }) {
  return (
    <select name="product_id" required className="rounded border px-2 py-1 text-sm">
      <option value="">Product…</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>
          {p.sku} — {p.name}
        </option>
      ))}
    </select>
  );
}

function WarehouseSelect({
  warehouses,
  name = "warehouse_id",
  label,
}: {
  warehouses: Warehouse[];
  name?: string;
  label?: string;
}) {
  return (
    <select name={name} required className="rounded border px-2 py-1 text-sm">
      <option value="">{label ? `${label}…` : "Warehouse…"}</option>
      {warehouses.map((w) => (
        <option key={w.id} value={w.id}>
          {w.code} — {w.name}
        </option>
      ))}
    </select>
  );
}

function ReconciliationPanel() {
  const [flags, setFlags] = useState<
    { id: string; flag_type: string; details: Record<string, unknown>; resolved: boolean; created_at: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const supabaseFlags = await api<{ flags: typeof flags }>("/api/reconciliation/flags");
      setFlags(supabaseFlags.flags);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load flags");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card title="Reconciliation flags (from the scheduled sweep)">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul className="space-y-1 text-sm">
        {flags.map((f) => (
          <li key={f.id} className={f.resolved ? "text-neutral-400 line-through" : "text-neutral-800"}>
            [{f.flag_type}] {JSON.stringify(f.details)}
          </li>
        ))}
        {flags.length === 0 && <li className="text-neutral-400">No flags — nothing to see here.</li>}
      </ul>
    </Card>
  );
}
