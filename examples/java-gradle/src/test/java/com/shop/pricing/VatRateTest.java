package com.shop.pricing;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class VatRateTest {
  @Test
  void acceptsZeroVat() {
    assertEquals(1000, new PriceCalculator(0).total(1000, 0));
  }

  @Test
  void rejectsNegativeVat() {
    assertThrows(IllegalArgumentException.class, () -> new PriceCalculator(-1));
  }
}
