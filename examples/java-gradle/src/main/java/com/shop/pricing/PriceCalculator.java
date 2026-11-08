package com.shop.pricing;

/** Order totals in cents: a percentage discount, then VAT, rounded half up. */
public final class PriceCalculator {
  private final int vatPercent;

  public PriceCalculator(int vatPercent) {
    if (vatPercent < 0 || vatPercent > 100) {
      throw new IllegalArgumentException("VAT must be between 0 and 100 percent");
    }
    this.vatPercent = vatPercent;
  }

  public long total(long netCents, int discountPercent) {
    if (netCents < 0) throw new IllegalArgumentException("the net amount cannot be negative");
    if (discountPercent < 0 || discountPercent > 100) {
      throw new IllegalArgumentException("the discount must be between 0 and 100 percent");
    }
    long discounted = roundedPercentOf(netCents, 100 - discountPercent);
    return roundedPercentOf(discounted, 100 + vatPercent);
  }

  private static long roundedPercentOf(long cents, int percent) {
    return (cents * percent + 50) / 100;
  }
}
