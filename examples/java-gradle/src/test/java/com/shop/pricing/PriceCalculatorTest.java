package com.shop.pricing;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class PriceCalculatorTest {
  private final PriceCalculator calculator = new PriceCalculator(20);

  @Test
  void addsVat() {
    assertEquals(1200, calculator.total(1000, 0));
  }

  @Test
  void appliesTheDiscountBeforeVat() {
    assertEquals(1080, calculator.total(1000, 10));
  }

  @Test
  void roundsHalfUp() {
    assertEquals(2, new PriceCalculator(0).total(3, 50));
  }

  @Test
  void rejectsDiscountsAboveOneHundredPercent() {
    assertThrows(IllegalArgumentException.class, () -> calculator.total(1000, 101));
  }
}
