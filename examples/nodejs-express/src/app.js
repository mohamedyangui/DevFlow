import express from "express";
import { OrderStore } from "./orders.js";

/** Builds the HTTP application around an order store. */
export function createApp(store = new OrderStore()) {
  const app = express();
  app.use(express.json());

  app.get("/api/orders", (req, res) => {
    res.json(store.list());
  });

  app.post("/api/orders", (req, res) => {
    const { customer, totalCents } = req.body ?? {};
    if (typeof customer !== "string" || customer === "" || !Number.isInteger(totalCents)) {
      res.status(400).json({ code: "INVALID_ORDER" });
      return;
    }
    res.status(201).json(store.add({ customer, totalCents }));
  });

  return app;
}
