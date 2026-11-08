package com.shop.orders;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class OrderControllerTest {
  private final OrderController controller = new OrderController(new OrderService(List.of(
      new OrderDto(1, "ada", 1250),
      new OrderDto(2, "grace", 4000))));

  @Test
  void listsEveryOrder() {
    OrderController.Response response = controller.list(Map.of());
    assertEquals(200, response.status());
    assertEquals(
        "[{\"id\":1,\"customer\":\"ada\",\"totalCents\":1250},"
            + "{\"id\":2,\"customer\":\"grace\",\"totalCents\":4000}]",
        response.body());
  }

  @Test
  void answersWithJson() {
    assertEquals("application/json", controller.list(Map.of()).headers().get("Content-Type"));
  }
}
