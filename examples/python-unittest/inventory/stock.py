"""Stock levels per product."""


class OutOfStock(Exception):
    """Raised when a reservation asks for more than is in stock."""


class Stock:
    def __init__(self) -> None:
        self._levels: dict[str, int] = {}

    def receive(self, sku: str, quantity: int) -> None:
        if quantity <= 0:
            raise ValueError("a delivery has at least one item")
        self._levels[sku] = self._levels.get(sku, 0) + quantity

    def reserve(self, sku: str, quantity: int) -> int:
        """Takes `quantity` items out of stock and returns what is left."""
        level = self._levels.get(sku, 0)
        if quantity > level:
            raise OutOfStock(sku)
        self._levels[sku] = level - quantity
        return self._levels[sku]

    def level(self, sku: str) -> int:
        return self._levels.get(sku, 0)
