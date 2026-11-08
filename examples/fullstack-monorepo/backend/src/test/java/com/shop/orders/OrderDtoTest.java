package com.shop.orders;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class OrderDtoTest {
  @Test
  void escapesQuotesAndControlCharacters() {
    assertEquals(
        "{\"id\":7,\"customer\":\"a\\\"b\\u000a\",\"totalCents\":0}",
        new OrderDto(7, "a\"b\n", 0).toJson());
  }
}
