"""The `facts` table as code — AGENT_CONTRACT §4 (spec §19, §53)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence
from uuid import UUID, uuid5, NAMESPACE_DNS

from typing import cast

from nexus_ai.contract import Fact, FactSource, MatchExplanation
from nexus_ai.trust import freshness


#: §4 conflict resolution order — merchant (fresh) > observed > imported > third_party
#: > inferred > demo. A tie is broken by `confidence`, then recency.
SOURCE_RANK: dict[str, int] = {
    "merchant": 5,
    "observed": 4,
    "imported": 3,
    "third_party": 2,
    "inferred": 1,
    # synthetic seed data keeps its own provenance instead of being clamped to a real-world one
    "demo": 0,
}

#: confidence ceiling by source: third-party data may never out-rank merchant data (§3)
SOURCE_CONFIDENCE_CAP: dict[str, float] = {
    "merchant": 1.0, "observed": 0.95, "imported": 0.9, "third_party": 0.7, "inferred": 0.5,
    "demo": 0.5,
}


def better_source(a: str, b: str) -> int:
    """>0 if `a` outranks `b`."""
    return SOURCE_RANK.get(a, 0) - SOURCE_RANK.get(b, 0)


def stable_fact_id(*parts: Any) -> UUID:
    """Content-derived id for facts we compute at request time.

    Not the seed generator's namespace, so a synthesised id can never collide with a
    stored `facts` row; not random, so replaying a request reproduces the same ids.
    """
    return uuid5(NAMESPACE_DNS, "|".join(str(p) for p in parts))


def facts_from_rows(rows: Iterable[dict[str, Any]], *, now: datetime | None = None) -> list[Fact]:
    """DB rows -> contract `Fact`, with `stale` recomputed against the §5 TTL table.

    A row that *claims* fresh but is past its TTL is reported stale — the DB flag never
    overrides the clock.
    """
    out: list[Fact] = []
    for r in rows:
        try:
            fid = UUID(str(r["fact_id"]))
            sid = UUID(str(r["subject_id"]))
        except (KeyError, ValueError, TypeError):
            continue
        value = r.get("value")
        if isinstance(value, str):
            import json

            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        observed = r.get("observed_at") or datetime.now(timezone.utc)
        expires = r.get("expires_at")
        state = freshness.evaluate(observed, str(r.get("attribute") or "description"),
                                   now=now, expires_at=expires,
                                   forced_stale=bool(r.get("stale")))
        # D501: a MISSING or UNKNOWN source resolves to `demo` - the bottom of the
        # hierarchy, the bucket for provenance that is not vouchable - and NEVER to a
        # source the row did not claim. AGENT_CONTRACT 4: "resolving an unknown source to
        # a known one is forbidden, because that launders where the number came from" -
        # and DECISIONS D25 ruling 3 named this clamping "provenance laundering, the
        # opposite of 109". `demo` is a first-class source ranked BELOW `inferred` on
        # purpose, so synthetic data states where it came from and never outranks a real
        # observation.
        source = str(r.get("source") or "").strip()
        if source not in SOURCE_RANK:
            source = "demo"
        conf = min(float(r.get("confidence") or 0.5), SOURCE_CONFIDENCE_CAP.get(source, 0.5))
        out.append(Fact(
            fact_id=fid, subject_type=str(r.get("subject_type") or "merchant"),
            subject_id=sid, attribute=str(r.get("attribute") or "unknown"), value=value,
            # D501: an UNKNOWN source resolves to `demo` - the bottom of the hierarchy,
            # the bucket for provenance that is not vouchable - and NEVER to a
            # source the row did not claim. AGENT_CONTRACT 4: "resolving an unknown
            # source to a known one is forbidden, because that launders where the
            # number came from" - and DECISIONS D25 ruling 3 named this clamping
            # "provenance laundering, the opposite of 109".
            source=cast(FactSource, source),
            confidence=round(conf, 3), observed_at=observed,
            expires_at=state.expires_at, stale=state.stale,
        ))
    return out


@dataclass
class FactBundle:
    """Facts for one request: the grounding set the verifier and renderer share."""
    facts: list[Fact] = field(default_factory=list)

    def by_subject(self, subject_id: Any) -> list[Fact]:
        return [f for f in self.facts if str(f.subject_id) == str(subject_id)]

    def by_attribute(self, attribute: str, subject_id: Any = None) -> list[Fact]:
        rows = [f for f in self.facts if f.attribute == attribute]
        if subject_id is not None:
            rows = [f for f in rows if str(f.subject_id) == str(subject_id)]
        return rows

    def get(self, attribute: str, subject_id: Any = None) -> Fact | None:
        rows = self.pick_all(attribute, subject_id)
        return rows[0] if rows else None

    def pick_all(self, attribute: str, subject_id: Any = None) -> list[Fact]:
        """Authoritative ordering per §4, and conflicts are surfaced not hidden."""
        rows = self.by_attribute(attribute, subject_id)
        return sorted(rows, key=lambda f: (better_source(f.source, "merchant"),
                                           f.confidence, f.observed_at), reverse=True)

    def values(self, attribute: str) -> set[str]:
        out: set[str] = set()
        for f in self.by_attribute(attribute):
            out |= _scalar_strings(f.value)
        return out

    def ids(self) -> list[UUID]:
        return [f.fact_id for f in self.facts]

    def add(self, fact: Fact) -> Fact:
        self.facts.append(fact)
        return fact

    def synth(self, *, subject_type: str, subject_id: Any, attribute: str, value: Any,
              source: str = "observed", confidence: float = 0.9,
              observed_at: datetime | None = None,
              expires_at: datetime | None = None) -> Fact:
        """Synthesise a Fact for a computed value (distance, open-now, availability).

        §4: anything shown to a user must resolve to a fact row, so the renderer needs a
        Fact even for numbers we computed ourselves. These are marked `inferred`/
        `observed` and are never given a merchant source they did not earn.
        """
        now = observed_at or datetime.now(timezone.utc)
        ttl = freshness.ttl_for_attribute(attribute)
        if expires_at is None and ttl > 0:
            expires_at = now + __import__("datetime").timedelta(seconds=ttl)
        cap = SOURCE_CONFIDENCE_CAP.get(source, 0.5)
        # A computed fact's id is a pure function of its content + observed_at (uuid5, not
        # uuid4): a replayed request yields byte-identical frames and re-synthesising the
        # same value is idempotent, which is what lets the SSE stream be reproducible.
        return self.add(Fact(
            fact_id=stable_fact_id(subject_type, subject_id, attribute, value, now),
            subject_type=subject_type, subject_id=UUID(str(subject_id)),
            attribute=attribute, value=value, source=cast(FactSource, source),
            confidence=round(min(confidence, cap), 3), observed_at=now,
            expires_at=expires_at,
            stale=ttl <= 0 and False,
        ))

    def explanations(self, attribute: str, subject_id: Any, label: str, text: str,
                     fmt: Any = None) -> list[MatchExplanation]:
        rows = self.pick_all(attribute, subject_id)
        if not rows:
            return []
        f = rows[0]
        return [MatchExplanation(label=label, text=text,
                                 value=(str(fmt) if fmt is not None else _first_scalar(f.value)),
                                 fact_id=f.fact_id)]


def _scalar_strings(value: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(value, dict):
        for v in value.values():
            out |= _scalar_strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            out |= _scalar_strings(v)
    elif value is not None:
        out.add(str(value))
    return out


def _first_scalar(value: Any) -> str | None:
    if isinstance(value, dict):
        for k in ("amount", "value", "text", "meters", "minutes"):
            if value.get(k) is not None:
                return str(value[k])
        vals = [v for v in value.values() if not isinstance(v, (dict, list))]
        return str(vals[0]) if vals else None
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else None
    return None if value is None else str(value)


def pick_authoritative(facts: Iterable[Fact]) -> Fact | None:
    """Best fact in a group by the §4 source hierarchy, then confidence, then recency."""
    rows = list(facts)
    if not rows:
        return None
    return sorted(rows, key=lambda f: (SOURCE_RANK.get(f.source, 0), f.confidence,
                                       f.observed_at), reverse=True)[0]


def resolve_conflicts(bundle: FactBundle, attribute: str, subject_id: Any,
                      *, tenant_id: str | None = None) -> tuple[Fact | None, list[dict[str, Any]]]:
    """§4: a conflict creates a `trust_signals` row rather than silently picking.

    Returns the chosen fact plus the conflict payloads the caller must insert.
    """
    rows = bundle.by_attribute(attribute, subject_id)
    if not rows:
        return None, []
    ordered = sorted(rows, key=lambda f: (better_source(f.source, "merchant"), f.confidence,
                                          f.observed_at), reverse=True)
    chosen = ordered[0]
    disagreements: list[dict[str, Any]] = []
    seen_values = {(_first_scalar(chosen.value))}
    for f in ordered[1:]:
        v = _first_scalar(f.value)
        if v in seen_values:
            continue
        seen_values.add(v)
        disagreements.append({
            "attribute": attribute,
            "kind": "price_anomaly" if attribute == "price" else "conflicting_fact",
            "severity": "warn" if chosen.source == "merchant" else "high",
            "merchant_id": str(subject_id),
            "evidence": {
                "chosen": {"fact_id": str(chosen.fact_id), "source": chosen.source,
                           "value": chosen.value, "confidence": chosen.confidence},
                "conflicting": {"fact_id": str(f.fact_id), "source": f.source,
                                "value": f.value, "confidence": f.confidence},
                "resolution": "source_hierarchy",
            },
            "detected_by": "rule",
            "tenant_id": tenant_id,
        })
    return chosen, disagreements


def select_display_facts(bundle: FactBundle, subject_id: Any,
                         attributes: Sequence[str]) -> list[Fact]:
    out: list[Fact] = []
    for attr in attributes:
        rows = bundle.pick_all(attr, subject_id)
        if rows:
            out.append(rows[0])
    return out
