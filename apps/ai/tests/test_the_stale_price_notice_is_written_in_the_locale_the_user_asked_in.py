"""§5's stale-price notice is the one card sentence that ignores the request's locale.

The claim: the sentence a card raises about a stale price is written in the language the
user asked in. Every other card string goes through the pipeline's locale - `build_card`
picks the title language, `REASON_COPY` picks the reason wording, the open-now meter and
the sponsored label all take `locale` as an argument - and then `attach_price_staleness`
prints `stale_copy("zh-HK")` with the literal in the callee, so an English request gets
繁体 and a Simplified request gets Traditional characters.

Measured on the live plane before writing this door (`tmp/d605_locale_probe.py`, query
`咖啡店`, limit 6, through `search()` with the real request locale):

    locale   price_stale bullets   text
    en       6/6 cards             價格可能已更新
    zh-CN    6/6 cards             價格可能已更新
    zh-HK    6/6 cards             價格可能已更新

The bullet is not rare, so the wrong-language path is not theoretical: every one of this
plane's 5,688 price facts is past its `expires_at` (newest `observed_at` 2026-09-22, and
the price TTL is 6 hours), so every priced card raises the notice. Fixing the locale
without noticing that would still leave a user who asks in English reading Traditional
Chinese on the only trust warning the card shows.

Two rows read the shipped source rather than the behaviour, because the defect is a
*choice made in the wrong place*: the callee naming a locale is red even if some future
caller passes one, and a caller that stops passing the locale it was given is red even if
the callee still defaults. The rest assert the rendered text.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from nexus_ai.contract import EntityCard, MatchExplanation
from nexus_ai.search import cards as cards_mod
from nexus_ai.search import service as service_mod
from nexus_ai.search.cards import attach_price_staleness
from nexus_ai.trust.facts import FactBundle
from nexus_ai.trust.freshness import STALE_COPY

NOW = datetime.now(timezone.utc).replace(microsecond=0)
SUBJECT = uuid4()

_CARDS_PY = Path(cards_mod.__file__).read_text(encoding="utf-8")
_SERVICE_PY = Path(service_mod.__file__).read_text(encoding="utf-8")


def _stale_card() -> tuple[EntityCard, FactBundle]:
    """A card whose price fact is stale - the state every live price fact is in."""
    bundle = FactBundle()
    fact = bundle.synth(subject_type="merchant", subject_id=SUBJECT, attribute="price",
                        value={"amount": 100}, source="merchant",
                        observed_at=NOW - timedelta(days=36))
    fact.stale = True
    return EntityCard(id=SUBJECT, slug="x", title="X"), bundle


def _notice(card: EntityCard) -> MatchExplanation | None:
    reasons = card.ai_match.reasons if card.ai_match else []
    return next((r for r in reasons if r.label == "price_stale"), None)


def _function_body(source: str, name: str) -> str:
    """One top-level function's own text, delimited by the module's blank lines."""
    start = source.index(f"def {name}(")
    tail = source[start:]
    end = tail.index("\n\n\n") if "\n\n\n" in tail else len(tail)
    return tail[:end]


# ------------------------------------------------------------------- the rendered sentence
def test_the_stale_price_notice_is_written_in_english_when_the_user_asked_in_english():
    card, bundle = _stale_card()
    attach_price_staleness(card, bundle, locale="en")
    notice = _notice(card)
    assert notice is not None, "no staleness notice was raised at all - §5 is not firing"
    assert notice.text == STALE_COPY["en"], (
        f"an English request was answered with {notice.text!r}; the plan's own contract is "
        f"that a notice about a price is written in the language the user is reading the "
        f"rest of the card in")


def test_the_stale_price_notice_is_written_simplified_when_the_user_asked_in_simplified():
    card, bundle = _stale_card()
    attach_price_staleness(card, bundle, locale="zh-CN")
    notice = _notice(card)
    assert notice is not None
    assert notice.text == STALE_COPY["zh-CN"], (
        f"a zh-CN request was answered with {notice.text!r} - Traditional characters in a "
        f"Simplified response, on the one line of the card that is a warning")


def test_the_stale_price_notice_keeps_traditional_for_the_planes_own_locale():
    card, bundle = _stale_card()
    attach_price_staleness(card, bundle, locale="zh-HK")
    assert _notice(card).text == STALE_COPY["zh-HK"]


def test_an_unsupported_locale_falls_back_to_the_default_language_not_to_nothing():
    """The fallback is `stale_copy`'s documented behaviour; this pins that plumbing the
    locale did not replace it with a missing key."""
    card, bundle = _stale_card()
    attach_price_staleness(card, bundle, locale="fr-FR")
    assert _notice(card).text == STALE_COPY["zh-HK"]


def test_the_notice_stays_grounded_when_the_locale_moves():
    """The locale is a copy choice, not a licence to ship an untraceable bullet (§4)."""
    for locale in ("en", "zh-CN", "zh-HK"):
        card, bundle = _stale_card()
        attach_price_staleness(card, bundle, locale=locale)
        assert _notice(card).fact_id is not None, (
            f"the {locale} notice cites no fact - it would be dropped by "
            f"`drop_ungrounded_reasons` before it reached a user")


# ------------------------------------------------------------------- who chooses the locale
def test_the_callee_does_not_choose_a_locale_of_its_own():
    body = _function_body(_CARDS_PY, "attach_price_staleness")
    assert "stale_copy(" in body, (
        "the reader found no `stale_copy` call in the function body, so the "
        "literal-free claim below is vacuous - the notice moved somewhere else")
    assert 'stale_copy("' not in body, (
        "the card's staleness notice still names a language inside itself: whichever "
        "locale the caller passes, the callee overrules it with a literal")


def test_the_pipeline_hands_the_notice_the_locale_it_was_given():
    calls = re.findall(r"attach_price_staleness\([^)\n]*\)", _SERVICE_PY)
    assert calls, "no production call of `attach_price_staleness` found - the reader is blind"
    for call in calls:
        assert re.search(r"locale\s*=\s*locale\b", call), (
            f"the search pipeline builds the card with the request locale and then calls "
            f"{call!r}: the notice has to be handed the same variable, not a literal that "
            f"happens to spell `locale`")


def test_the_callee_cannot_be_called_without_naming_a_locale():
    """A defaulted locale re-opens the hole: a future caller that forgets the argument
    prints Traditional Chinese to an English reader, and nothing fails."""
    card, bundle = _stale_card()
    try:
        attach_price_staleness(card, bundle)
    except TypeError:
        return
    raise AssertionError(
        "attach_price_staleness still runs without a locale, so the locale is optional "
        "at every call site and the shipped default is the defect this door exists for")


# ------------------------------------------------------------------- the copy table
def test_the_stale_copy_table_covers_every_locale_the_card_builder_admits():
    """`build_card`'s own guard names the supported set; a locale it admits must have a
    real stale sentence rather than silently falling back."""
    guard = re.search(r"locale in \(([^)]*)\)", _CARDS_PY)
    assert guard, "the pipeline's locale guard was not found - the claim has nothing to read"
    supported = {v.strip().strip('"') for v in guard.group(1).split(",")}
    assert supported <= set(STALE_COPY), (
        f"the card builder admits {sorted(supported - set(STALE_COPY))} with no stale "
        f"sentence behind it - those requests get the fallback while the rest of the card "
        f"is localised")
