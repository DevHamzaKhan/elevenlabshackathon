import pytest

from caller.phone import is_allowed, is_e164, parse_allowlist


@pytest.mark.parametrize("n", ["+14155550123", "+447911123456", "+1234567", "+123456789012345"])
def test_e164_valid(n):
    assert is_e164(n)


@pytest.mark.parametrize("n", ["14155550123", "+04155550123", "+1 415 555 0123", "+123456",
                               "+1234567890123456", "", None, 14155550123, "+1415555012a",
                               "+14155550123\n"])
def test_e164_invalid(n):
    assert not is_e164(n)


def test_allowlist_parsing_trims_and_drops_invalid():
    al = parse_allowlist(" +14155550123, +14155550124 ,,bogus, 4155550125 ")
    assert al == frozenset({"+14155550123", "+14155550124"})


@pytest.mark.parametrize("raw", ["", None, " , "])
def test_allowlist_empty(raw):
    assert parse_allowlist(raw) == frozenset()


def test_is_allowed():
    al = parse_allowlist("+14155550123")
    assert is_allowed("+14155550123", al)
    assert not is_allowed("+14155550124", al)
    assert not is_allowed("+1 4155550123", al)
    assert not is_allowed(None, al)
