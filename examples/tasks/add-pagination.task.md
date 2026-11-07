---
id: TASK-142
scope:
  modules: [backend]
testing:
  levels: [unit, integration]
---

# Add pagination to GET /api/orders

The orders list endpoint returns every order in a single response and times out for
customers with many orders. Add offset pagination without breaking existing clients.

## Requirements

- FR-1: GET /api/orders accepts optional `page` (0-based) and `size` query parameters.
- FR-2: The response includes an X-Total-Count header with the total number of orders.
- NFR-1 [compatibility]: Clients that send no pagination parameters keep receiving the same
  JSON shape.

## Acceptance Criteria

- [ ] **AC-1**: Second page of results (covers: FR-1, FR-2) (integration)
  - Given 25 orders exist
  - When a client calls GET /api/orders?page=1&size=10
  - Then orders 11 to 20 are returned and X-Total-Count is 25
- [ ] **AC-2**: Requesting more than 100 orders per page returns 400 with the error code
      PAGE_SIZE_TOO_LARGE (covers: FR-1)
- [ ] **AC-3**: A request without pagination parameters returns the first 50 orders in the
      existing response format (covers: NFR-1) (regression)

## Constraints

- Do not change the OrderDto JSON shape.
- Follow the existing controller and service layering.

## Definition of Done

- Every acceptance criterion has a passing automated test.
- The backend test gate passes with no regressions.
