package com.shop.orders;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  /** Returns every order in one response. */
  @GetMapping("/api/orders")
  public List<OrderDto> list() {
    return service.findAll();
  }
}
