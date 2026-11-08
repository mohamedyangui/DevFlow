package com.shop.orders;

import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;

/** Keeps orders in memory, in the order they were placed. */
@Service
public class OrderService {
  private final List<OrderDto> orders = new ArrayList<>();

  public OrderService() {
    this(List.of(
        new OrderDto(1, "ada", 1250),
        new OrderDto(2, "grace", 4000),
        new OrderDto(3, "linus", 990)));
  }

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
