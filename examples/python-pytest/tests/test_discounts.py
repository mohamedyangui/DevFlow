import pytest

from pricing.discounts import add_vat, apply_discount


def test_ac1_applies_the_discount() -> None:
    assert apply_discount(1000, 15) == 850


def test_ac1_rounds_half_up() -> None:
    assert apply_discount(999, 5) == 949


def test_ac2_rejects_discounts_above_one_hundred_percent() -> None:
    with pytest.raises(ValueError):
        apply_discount(1000, 101)


@pytest.mark.parametrize(("cents", "expected"), [(1000, 1200), (5, 6)])
def test_adds_vat(cents: int, expected: int) -> None:
    assert add_vat(cents, 20) == expected
