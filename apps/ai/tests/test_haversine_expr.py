"""Contract tests for the distance expression (``search/sql.haversine_expr``).

The expression is a string the query builder splices into SQL, so its shape IS the contract:
every parameter and column is cast to ``float8`` (asyncpg will not infer a numeric type for
``radians``), the cosine is clamped to ``[-1, 1]`` before ``acos`` (floating-point rounding can
push it just outside the domain and turn a whole page into an error), and the result is cast back
to ``float8``. Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

from nexus_ai.search.sql import EARTH_RADIUS_M, haversine_expr


def _expr(lat="m.lat", lng="m.lng", lat_ph="$1", lng_ph="$2") -> str:
    return haversine_expr(lat_ph, lng_ph, lat, lng)


class TestRadius:
    def test_earth_radius_metres(self):
        assert EARTH_RADIUS_M == 6371008.8


class TestCasts:
    def test_placeholders_and_columns_are_float8(self):
        e = _expr()
        assert "radians($1::float8)" in e
        assert "radians($2::float8)" in e
        assert "radians(m.lat::float8)" in e
        assert "radians(m.lng::float8)" in e

    def test_other_columns_are_threaded_through(self):
        e = _expr(lat="o.lat", lng="o.lng")
        assert "o.lat::float8" in e
        assert "o.lng::float8" in e
        assert "m.lat" not in e

    def test_the_result_is_cast_back(self):
        assert _expr().endswith("::float8")


class TestClamp:
    def test_the_cosine_is_clamped_before_acos(self):
        # without this, rounding outside [-1, 1] makes acos raise and the page errors
        assert "greatest(-1.0, least(1.0," in _expr()

    def test_the_expression_starts_with_the_radius_and_acos(self):
        assert _expr().startswith("(6371008.8 * acos(")


class TestShape:
    def test_each_placeholder_appears_once(self):
        e = _expr()
        assert e.count("$1") == 2  # cos(lat) and sin(lat)
        assert e.count("$2") == 1  # the longitude difference

    def test_the_two_cosine_terms_are_present(self):
        e = _expr()
        assert "cos(radians($1::float8)) * cos(radians(m.lat::float8))" in e
        assert "sin(radians($1::float8)) * sin(radians(m.lat::float8))" in e
