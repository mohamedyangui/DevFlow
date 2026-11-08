import { describe, expect, it } from "vitest";
import { fetchOrders, formatTotal, type Fetch } from "../src/orders.js";

const respond =
  (status: number, body: unknown): Fetch =>
  () =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

describe("fetchOrders", () => {
  it("returns the orders of the backend", async () => {
    const orders = [{ id: 1, customer: "ada", totalCents: 1250 }];
    expect(await fetchOrders(respond(200, orders))).toEqual(orders);
  });

  it("rejects an error status", async () => {
    await expect(fetchOrders(respond(500, null))).rejects.toThrow("failed with 500");
  });

  it("rejects a body that is not a list of orders", async () => {
    await expect(fetchOrders(respond(200, [{ id: "1" }]))).rejects.toThrow("unexpected body");
  });
});

describe("formatTotal", () => {
  it("formats cents as euros", () => {
    expect(formatTotal(1250)).toBe("12.50 EUR");
    expect(formatTotal(5)).toBe("0.05 EUR");
    expect(formatTotal(-990)).toBe("-9.90 EUR");
  });
});
