"""Contract tests for the eval harness's pure logic (``eval/suites`` + ``eval/intent_v1``).

A suite keeps three questions apart: did the case pass, what is the metric, and does the gate
hold. These are pure and DB-free — the only I/O is reading a JSONL case file, which is driven from
a tmp dir here.

Every assertion was confirmed against the running modules (empirical probe), never guessed.
"""

from __future__ import annotations

import pytest

import nexus_ai.eval.intent_v1 as I
import nexus_ai.eval.suites as S


class TestGate:
    def test_ge_inclusive(self):
        assert S.Gate("n", "m", ">=", 0.9, 0.9).passed is True

    def test_ge_below_fails(self):
        assert S.Gate("n", "m", ">=", 0.9, 0.89).passed is False

    def test_le_inclusive(self):
        assert S.Gate("n", "m", "<=", 0.02, 0.02).passed is True

    def test_le_above_fails(self):
        assert S.Gate("n", "m", "<=", 0.02, 0.03).passed is False

    def test_eq(self):
        assert S.Gate("n", "m", "==", 1.0, 1.0).passed is True

    def test_unknown_comparator_raises(self):
        with pytest.raises(ValueError):
            S.Gate("n", "m", "~", 1, 1).passed

    def test_as_dict(self):
        d = S.Gate("n", "m", ">=", 0.9, 0.95, detail="d").as_dict()
        assert d["passed"] is True
        assert d["detail"] == "d"


class TestSuiteResult:
    def test_ok_when_clean(self):
        assert S.SuiteResult(name="x", cases=2, passed=2).ok is True

    def test_not_ok_with_failure(self):
        assert S.SuiteResult(name="x", cases=2, passed=1, failures=["f"]).ok is False

    def test_not_ok_with_failed_gate(self):
        r = S.SuiteResult(name="x", cases=1, passed=1,
                          gates=[S.Gate("n", "m", "<=", 0.02, 0.5)])
        assert r.ok is False

    def test_as_dict_counts_failed(self):
        d = S.SuiteResult(name="x", cases=2, passed=1, failures=["f"]).as_dict()
        assert d["failed"] == 1
        assert d["ok"] is False
        assert d["failures"] == ["f"]


class TestRate:
    def test_empty_denominator_is_one(self):
        # no cases -> nothing failed -> 1.0 (the empty case is named, not hidden)
        assert S.rate(0, 0) == 1.0

    def test_half(self):
        assert S.rate(1, 2) == 0.5

    def test_zero_numerator(self):
        assert S.rate(0, 5) == 0.0


class TestEmpty:
    @pytest.mark.parametrize("value", [None, {}, [], "", 0])
    def test_empty_values(self, value):
        assert I._empty(value) is True

    @pytest.mark.parametrize("value", [1, "x"])
    def test_non_empty_values(self, value):
        assert I._empty(value) is False


class TestMatches:
    def test_dict_is_subset(self):
        assert I._matches({"a": 1, "b": 2}, {"a": 1}) is True

    def test_dict_missing_key_fails(self):
        assert I._matches({"a": 1}, {"b": 2}) is False

    def test_list_is_containment(self):
        assert I._matches([{"x": 1}, {"y": 2}], [{"y": 2}]) is True

    def test_scalar_equality(self):
        assert I._matches(5, 5) is True

    def test_type_mismatch_fails(self):
        assert I._matches(5, "5") is False

    def test_nested_subset(self):
        assert I._matches({"budget": {"max": 500, "per": "party"}},
                          {"budget": {"max": 500}}) is True


class TestLoadCases:
    def _write(self, tmp_path, name, text):
        (tmp_path / f"{name}.jsonl").write_text(text, encoding="utf-8")

    def test_missing_file_raises(self, monkeypatch, tmp_path):
        monkeypatch.setattr(S, "DATA_DIR", tmp_path)
        with pytest.raises(FileNotFoundError):
            S.load_cases("nope")

    def test_valid_jsonl_skips_blank_and_comments(self, monkeypatch, tmp_path):
        monkeypatch.setattr(S, "DATA_DIR", tmp_path)
        self._write(tmp_path, "demo", '{"id":"a"}\n// comment\n\n{"id":"b"}\n')
        assert S.load_cases("demo") == [{"id": "a"}, {"id": "b"}]

    def test_bad_json_raises(self, monkeypatch, tmp_path):
        monkeypatch.setattr(S, "DATA_DIR", tmp_path)
        self._write(tmp_path, "bad", "{not json}\n")
        with pytest.raises(ValueError):
            S.load_cases("bad")

    def test_missing_id_raises(self, monkeypatch, tmp_path):
        monkeypatch.setattr(S, "DATA_DIR", tmp_path)
        self._write(tmp_path, "noid", '{"query":"x"}\n')
        with pytest.raises(ValueError):
            S.load_cases("noid")

    def test_no_cases_raises(self, monkeypatch, tmp_path):
        monkeypatch.setattr(S, "DATA_DIR", tmp_path)
        self._write(tmp_path, "empty", "\n// only comments\n")
        with pytest.raises(ValueError):
            S.load_cases("empty")


class TestIntentV1Run:
    CASES = [
        {"id": "ok", "query": "搵尖沙咀餐廳", "expect": {"category": "restaurant"}},
        {"id": "bad", "query": "餐廳", "expect": {"category": "cafe"}},
        {"id": "hall", "query": "搵尖沙咀餐廳", "must_not": ["location"]},
    ]

    def test_metrics_and_gates(self):
        res = I.run(self.CASES)
        assert res.cases == 3
        assert res.passed == 1
        assert res.metrics["accuracy"] == pytest.approx(2 / 3)
        assert res.metrics["hallucination_rate"] == pytest.approx(1 / 3)
        assert res.metrics["case_pass_rate"] == pytest.approx(1 / 3)
        assert [g.passed for g in res.gates] == [False, False]

    def test_failures_name_the_reason(self):
        res = I.run(self.CASES)
        joined = "\n".join(res.failures)
        assert "bad:" in joined
        assert "hall:" in joined
        assert "invented" in joined

    def test_all_passing_cases_meet_gates(self):
        res = I.run([{"id": "ok", "query": "搵尖沙咀餐廳", "expect": {"category": "restaurant"}}])
        assert res.ok is True
        assert all(g.passed for g in res.gates)
