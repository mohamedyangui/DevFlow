package com.shop.orders;

/** An order as the API returns it. Clients depend on this JSON shape. */
public record OrderDto(long id, String customer, long totalCents) {
  public String toJson() {
    return "{\"id\":" + id + ",\"customer\":\"" + escape(customer) + "\",\"totalCents\":"
        + totalCents + "}";
  }

  private static String escape(String text) {
    StringBuilder out = new StringBuilder();
    for (char c : text.toCharArray()) {
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        default -> {
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    return out.toString();
  }
}
