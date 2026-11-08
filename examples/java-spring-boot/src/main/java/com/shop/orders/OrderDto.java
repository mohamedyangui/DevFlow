package com.shop.orders;

/** An order as the API returns it. Clients depend on this JSON shape. */
public record OrderDto(long id, String customer, long totalCents) {}
