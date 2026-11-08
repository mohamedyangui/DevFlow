import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { OrderStore } from "../src/orders.js";

describe("GET /api/orders", () => {
  it("lists every order, oldest first", async () => {
    const store = new OrderStore([
      { customer: "ada", totalCents: 1250 },
      { customer: "grace", totalCents: 4000 },
    ]);
    const response = await request(createApp(store)).get("/api/orders");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: 1, customer: "ada", totalCents: 1250 },
      { id: 2, customer: "grace", totalCents: 4000 },
    ]);
  });
});

describe("POST /api/orders", () => {
  it("creates an order", async () => {
    const response = await request(createApp())
      .post("/api/orders")
      .send({ customer: "linus", totalCents: 990 });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: 1, customer: "linus", totalCents: 990 });
  });

  it("rejects an order without a customer", async () => {
    const response = await request(createApp()).post("/api/orders").send({ totalCents: 990 });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: "INVALID_ORDER" });
  });
});
