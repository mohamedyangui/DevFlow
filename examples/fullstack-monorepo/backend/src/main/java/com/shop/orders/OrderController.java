package com.shop.orders;

import java.util.Map;
import java.util.stream.Collectors;

/** Handles GET /api/orders. The HTTP server in {@link com.shop.ShopServer} calls it. */
public class OrderController {
  /** A response: status code, headers and a JSON body. */
  public record Response(int status, Map<String, String> headers, String body) {}

  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  /** Returns every order in one response (TASK-142 adds pagination). */
  public Response list(Map<String, String> query) {
    String body = service.findAll().stream()
        .map(OrderDto::toJson)
        .collect(Collectors.joining(",", "[", "]"));
    return new Response(200, Map.of("Content-Type", "application/json"), body);
  }
}
