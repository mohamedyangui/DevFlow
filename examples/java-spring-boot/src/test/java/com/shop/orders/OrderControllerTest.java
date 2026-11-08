package com.shop.orders;

import static org.hamcrest.Matchers.hasSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class OrderControllerTest {
  private MockMvc mvc;

  @BeforeEach
  void setUp() {
    OrderService service = new OrderService(List.of(
        new OrderDto(1, "ada", 1250),
        new OrderDto(2, "grace", 4000)));
    mvc = MockMvcBuilders.standaloneSetup(new OrderController(service)).build();
  }

  @Test
  void listsEveryOrder() throws Exception {
    mvc.perform(get("/api/orders"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$", hasSize(2)));
  }

  @Test
  void keepsTheOrderJsonShape() throws Exception {
    mvc.perform(get("/api/orders"))
        .andExpect(jsonPath("$[0].id").value(1))
        .andExpect(jsonPath("$[0].customer").value("ada"))
        .andExpect(jsonPath("$[0].totalCents").value(1250));
  }
}
