import unittest

from inventory.stock import OutOfStock, Stock


class TestStock(unittest.TestCase):
    def setUp(self) -> None:
        self.stock = Stock()
        self.stock.receive("mug", 3)

    def test_ac1_reserves_items_in_stock(self) -> None:
        self.assertEqual(self.stock.reserve("mug", 2), 1)

    def test_ac2_refuses_more_than_the_stock(self) -> None:
        with self.assertRaises(OutOfStock):
            self.stock.reserve("mug", 4)

    def test_receiving_adds_to_the_level(self) -> None:
        self.stock.receive("mug", 2)
        self.assertEqual(self.stock.level("mug"), 5)

    def test_rejects_empty_deliveries(self) -> None:
        with self.assertRaises(ValueError):
            self.stock.receive("mug", 0)
