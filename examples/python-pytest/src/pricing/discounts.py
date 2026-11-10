"""Discounts and VAT, in cents."""


def apply_discount(cents: int, percent: int) -> int:
    """Returns the price after a discount of `percent`, rounded half up."""
    if percent < 0 or percent > 100:
        raise ValueError("a discount is between 0 and 100 percent")
    return cents - (cents * percent + 50) // 100


def add_vat(cents: int, rate: int) -> int:
    """Returns the price with `rate` percent VAT added, rounded half up."""
    return cents + (cents * rate + 50) // 100
