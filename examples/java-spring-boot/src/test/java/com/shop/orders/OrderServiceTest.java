package com.shop.orders;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.List;
import org.junit.jupiter.api.Test;

class OrderServiceTest {
  @Test
  void returnsOrdersOldestFirst() {
    OrderService service = new OrderService();
    assertEquals(List.of(1L, 2L, 3L), service.findAll().stream().map(OrderDto::id).toList());
    assertEquals(3, service.count());
  }

  @Test
  void returnsACopyThatCannotBeChanged() {
    OrderService service = new OrderService();
    assertThrows(UnsupportedOperationException.class, () -> service.findAll().clear());
  }
}
