package com.shop;

import com.shop.orders.OrderController;
import com.shop.orders.OrderDto;
import com.shop.orders.OrderService;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Serves the orders API with the JDK's built-in HTTP server. */
public final class ShopServer {
  private ShopServer() {}

  public static void main(String[] args) throws IOException {
    OrderController orders = new OrderController(new OrderService(List.of(
        new OrderDto(1, "ada", 1250),
        new OrderDto(2, "grace", 4000))));
    HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 8080), 0);
    server.createContext("/api/orders", exchange -> {
      if (!"GET".equals(exchange.getRequestMethod())) {
        exchange.sendResponseHeaders(405, -1);
        exchange.close();
        return;
      }
      OrderController.Response response = orders.list(query(exchange.getRequestURI().getRawQuery()));
      byte[] body = response.body().getBytes(StandardCharsets.UTF_8);
      response.headers().forEach(exchange.getResponseHeaders()::set);
      exchange.sendResponseHeaders(response.status(), body.length);
      try (OutputStream out = exchange.getResponseBody()) {
        out.write(body);
      }
    });
    server.start();
    System.out.println("shop-backend listening on http://localhost:8080");
  }

  static Map<String, String> query(String raw) {
    Map<String, String> params = new HashMap<>();
    if (raw == null || raw.isEmpty()) return params;
    for (String pair : raw.split("&")) {
      int eq = pair.indexOf('=');
      String key = eq < 0 ? pair : pair.substring(0, eq);
      String value = eq < 0 ? "" : pair.substring(eq + 1);
      params.put(URLDecoder.decode(key, StandardCharsets.UTF_8),
          URLDecoder.decode(value, StandardCharsets.UTF_8));
    }
    return params;
  }
}
