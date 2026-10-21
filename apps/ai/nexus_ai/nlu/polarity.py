"""§7.1 / §8 — preference polarity: a negated preference is a DISLIKE, not a like.

The lexicon's `PREFERENCE_RULES` carry a fixed polarity (every rule is +1 today). A user who
says "唔好安靜" (not quiet) or "not quiet" is expressing a dislike, and the extractor must record
that as `polarity=-1` so the ranking lane can demote rather than boost.

The rule is deliberately narrow: a negation cue must GOVERN the token. A cue immediately before
the token (modulo short filler) governs that token alone; a cue elsewhere in the sentence governs
the whole turn, EXCEPT when other words separate it from the token by more than a filler, in
which case the two belong to different clauses and the token keeps its positive polarity. A
sentence carrying two preferences and one negation is therefore not silently turned into a
dislike of both.
"""

from __future__ import annotations

import re
from typing import Any

#: Negation cues that mean "not this". The Chinese ones are the ones users actually type;
#: the English ones keep the English lexicon rows honest.
NEGATION_CUES: tuple[str, ...] = (
    "唔好", "唔要", "唔想", "唔鍾意", "唔鍾", "唔食", "唔想要", "不要", "不想", "不喜歡", "不喜欢",
    "不想要", "讨厌", "討厭", "没咩", "冇", "唔係", "不是", "不好",
    "not ", "no ", "don't", "dont", "do not", "avoid", "without", "hate", "dislike",
)

#: How far back a cue may reach to govern a token. CJK needs a wider window than latin
#: because there are no spaces to bound the phrase.
_NEGATION_WINDOW_CJK = 6
_NEGATION_WINDOW_LATIN = 16

#: D447: the cue table is canonicalised at import, like the lexicon's (D435), the state
#: merger's (D421) and the time parser's (D446). The text is canonicalised before it
#: reaches the polarity, so a Simplified entry here could never match.
_CANONICALISED_TABLES = ("NEGATION_CUES",)


def _canonicalise_tables() -> None:
    """Put every cue table in this module in the canonical spelling."""
    import sys

    from nexus_ai.nlu.canonical import canonical_node

    module = sys.modules[__name__]
    for name in _CANONICALISED_TABLES:
        table = getattr(module, name, None)
        if table is None:
            continue
        setattr(module, name, canonical_node(table))


_canonicalise_tables()

#: The cue must be the LAST thing before the token (modulo a short filler) for a
#: token-local negation. Anything else is a sentence-level negation.
_LOCAL_FILLER = re.compile(r"^[的地得咗喇啦呢個個,\s]*")


def _window_for(token: str) -> int:
    return _NEGATION_WINDOW_CJK if any("一" <= ch <= "鿿" for ch in token) else _NEGATION_WINDOW_LATIN




def polarity_for(text: str, token: str) -> int:
    """+1 when the preference is wanted, -1 when it is negated, 0 when it is ungoverned.

    The token's own position decides: a cue before the token, close enough and with nothing
    but filler between them, governs the token; a cue elsewhere in the sentence governs the
    whole turn unless other words separate it from the token.
    """
    low = text.lower()
    tok = token.lower()
    if not tok:
        return 0

    idx = low.find(tok)
    if idx < 0:
        return 0

    window = _window_for(token)
    for cue in NEGATION_CUES:
        cue_at = low.find(cue)
        if cue_at < 0:
            continue
        # The cue must not sit inside the preference token itself.
        if cue_at >= idx and cue_at < idx + len(tok):
            continue
        if cue_at < idx:
            if cue_at < idx - window:
                continue  # too far back to reach this token
            between = low[cue_at + len(cue):idx]
            if not between.strip():
                return -1  # adjacent
            if len(between) <= 3 and _LOCAL_FILLER.match(between):
                return -1  # only filler between them
            # Other words separate them: a different clause, so the token keeps its polarity.
            continue
        # The cue sits AFTER the token: it governs the turn.
        return -1

    return 1


def apply_polarity(preferences: list[dict[str, Any]], text: str,
                    tokens: dict[tuple[str, str], str] | None = None) -> list[dict[str, Any]]:
    """Re-stamp each preference's polarity from the sentence it came from.

    The lexicon's fixed polarity is the default; the sentence overrides it only when it
    actually negates the preference. `tokens` maps a preference's (key, value) to the
    surface token that matched it in the sentence — the canonical value ("quiet") is not
    in a Chinese sentence, but the token that matched ("安靜") is.
    """
    out: list[dict[str, Any]] = []
    for pref in preferences:
        key = str(pref.get("key") or "")
        value = str(pref.get("value") or "")
        token = ""
        if tokens is not None:
            token = tokens.get((key, value), "")
        if not token:
            token = value or key
        if token and token.lower() in text.lower():
            sign = polarity_for(text, token)
            if sign:
                pref = {**pref, "polarity": sign}
        out.append(pref)
    return out
