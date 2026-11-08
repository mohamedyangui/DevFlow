/** Orders kept in memory, oldest first. */
export class OrderStore {
  #orders = [];
  #nextId = 1;

  constructor(orders = []) {
    for (const order of orders) this.add(order);
  }

  add({ customer, totalCents }) {
    const order = { id: this.#nextId++, customer, totalCents };
    this.#orders.push(order);
    return order;
  }

  list() {
    return this.#orders.map((order) => ({ ...order }));
  }
}
