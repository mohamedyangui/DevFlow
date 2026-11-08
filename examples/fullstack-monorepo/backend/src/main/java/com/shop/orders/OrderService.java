package com.shop.orders;

import java.util.ArrayList;
import java.util.List;

/** Keeps orders in memory, in the order they were placed. */
public class OrderService {
  private final List<OrderDto> orders = new ArrayList<>();

  public OrderService(List<OrderDto> orders) {
    this.orders.addAll(orders);
  }

  /** Every order, oldest first. */
  public List<OrderDto> findAll() {
    return List.copyOf(orders);
  }

  public long count() {
    return orders.size();
  }
}
