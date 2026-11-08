/** An order as GET /api/orders returns it. */
export interface Order {
  readonly id: number;
  readonly customer: string;
  readonly totalCents: number;
}

export type Fetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function isOrder(value: unknown): value is Order {
  if (typeof value !== "object" || value === null) return false;
  const order = value as Record<string, unknown>;
  return (
    typeof order.id === "number" &&
    typeof order.customer === "string" &&
    typeof order.totalCents === "number"
  );
}

/** Loads every order from the backend. */
export async function fetchOrders(fetch: Fetch, baseUrl = ""): Promise<Order[]> {
  const response = await fetch(`${baseUrl}/api/orders`);
  if (!response.ok) throw new Error(`GET /api/orders failed with ${String(response.status)}`);
  const body = await response.json();
  if (!Array.isArray(body) || !body.every(isOrder)) {
    throw new Error("GET /api/orders returned an unexpected body");
  }
  return body;
}

/** Formats an amount in cents as euros, e.g. 1250 as "12.50 EUR". */
export function formatTotal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")} EUR`;
}
