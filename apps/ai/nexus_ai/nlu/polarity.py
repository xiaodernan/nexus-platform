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

D533 adds the one exemption that rule was missing: the existential question. "有冇辣?" asks
whether spicy exists - it does not refuse it. The cue under a leading 有 is the question's own
verb, and the product's ASK_MERCHANT_CUES already spells 有無 / 有无 / 有冇 as questions. Two
tables named the same characters with opposite meanings and this reader had to pick one; it
picked the refusal, so a question came back as a dislike of the very thing asked about.
"""

from __future__ import annotations

import re
from typing import Any

#: Negation cues that mean "not this". The Chinese ones are the ones users actually type;
#: the English ones keep the English lexicon rows honest.
#:
#: D534 added 無 and 沒有 - the standard-written refusals, next to the Cantonese 冇 the
#: table already carried: measured, "無素食" read as a LIKE of vegetarian and the ranking
#: lane then boosted it (the D522 shape). 没有 is spelled out beside 沒有 because the
#: canonical table has no 没 -> 沒 entry, so canonicalisation cannot unify the two
#: spellings and a Simplified user's refusal would go unread; the map's hole is filed in
#: PLAN, and when it is filled this row canonicalises into 沒有 and costs nothing.
NEGATION_CUES: tuple[str, ...] = (
    "唔好", "唔要", "唔想", "唔鍾意", "唔鍾", "唔食", "唔想要", "不要", "不想", "不喜歡", "不喜欢",
    "不想要", "讨厌", "討厭", "没咩", "冇", "無", "沒有", "没有", "唔係", "不是", "不好",
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

#: What may sit between a cue and the token it governs. A clause boundary ends the
#: clause, so a cue on the far side of a comma belongs to another clause and governs
#: nothing there. Inside a clause, the Cantonese sentence particles do not separate
#: anything, and a short word gap is still the same clause - "唔好食辣" (don't EAT
#: spicy) refuses the spicy, and "唔好咁嘈" (don't be SO noisy) refuses the 嘈 with the
#: degree adverb 咁 still in between. The rule this replaces was `_LOCAL_FILLER.match(between)`,
#: a pattern whose `*` quantifier matched the empty string, so ANY gap of three
#: characters or fewer read as filler and the boundary was never enforced at all.
_CLAUSE_BOUNDARY = re.compile(r"[,，。;；!?！？\n]")
_LOCAL_FILLER = re.compile(r"[的地得咁咗喇啦呢個個\s]*")
_ATTACHED_GAP = 3

#: D535: the words that COORDINATE two clauses. The normalizer turns a clause comma
#: into a space, but the conjunction survives it - so "cheap and no curry" still says
#: which clause the refusal belongs to, and the reader must read it: the refusal is the
#: curry's, not the cheap's. Written in the canonical spelling, like every cue table
#: here (the text is canonicalised before it reaches this module, D447).
_CLAUSE_CONJUNCTIONS = ("and", "or", "but", "同埋", "同", "和", "跟",
                        "但是", "不過")

#: D535: ONE verb may sit between a refusal and the thing refused without ending the
#: clause - "I do not WANT spicy", "唔好食辣". Without it, the natural English refusal
#: read as a LIKE: measured, "I do not want spicy food" answered +1 and the ranking
#: lane boosted the very thing refused (the D522 shape, in English).
_VERB_BRIDGE = ("want", "like", "eat", "have", "要", "想", "食", "吃", "鍾意", "喜歡")


def clause_attached(between: str) -> bool:
    """Whether a cue and a token separated by `between` are in the same clause.

    D536: the CONSTRAINT lane reads governance through this function too. It had its
    own eight-character window, which is not a clause: measured, it could not reach
    "no coriander" (the value is nine characters) nor "don't want spicy" (one verb
    and two spaces sat in the way), and widening it read "no rush want spicy" as a
    refusal of the spicy. One reader for both lanes, so the two cannot disagree about
    what a refusal governs.
    """
    gap = between.strip()
    if not gap:
        return True
    if _CLAUSE_BOUNDARY.search(gap):
        return False
    if any(conj in gap for conj in _CLAUSE_CONJUNCTIONS):
        return False
    if _LOCAL_FILLER.fullmatch(gap):
        return True
    if len(gap) <= _ATTACHED_GAP:
        return True
    return gap in _VERB_BRIDGE


def _window_for(token: str) -> int:
    return _NEGATION_WINDOW_CJK if any("一" <= ch <= "鿿" for ch in token) else _NEGATION_WINDOW_LATIN


#: D533: the lead of the existential question. 有冇 / 有無 / 有没有 all ask "is there
#: any", and the cue that follows the 有 is the question's verb, not a refusal - so a
#: cue sitting directly under a 有 governs nothing.
_EXISTENTIAL_LEAD = "有"


def is_existential_question(low: str, cue_at: int) -> bool:
    """Whether the cue at `cue_at` is the tail of 有冇 / 有無 / 有没有 - a question, not a refusal."""
    lead = cue_at - len(_EXISTENTIAL_LEAD)
    return lead >= 0 and low[lead:cue_at] == _EXISTENTIAL_LEAD


def polarity_for(text: str, token: str) -> int:
    """+1 when the preference is wanted, -1 when it is negated, 0 when it is ungoverned.

    The token's own position decides. A cue ATTACHED to the token - immediately before
    or after it, modulo a short in-clause gap - governs that token and nothing else. A
    cue elsewhere in the sentence governs the turn only when no clause boundary and no
    more than a short gap separates it from the token; otherwise the two belong to
    different clauses and the token keeps its positive polarity. A cue under the lead of
    the existential question (有冇 X) governs nothing at all (D533).
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
        # Every occurrence, not just the first: "有冇辣，冇海鮮" asks about spicy and
        # refuses seafood, and a reader that stops at the first 冇 answers neither.
        cue_at = low.find(cue)
        while cue_at >= 0:
            # The cue must not sit inside the preference token itself.
            if cue_at >= idx and cue_at < idx + len(tok):
                cue_at = low.find(cue, cue_at + 1)
                continue
            # D533: a cue under a leading 有 is the existential question's verb.
            if is_existential_question(low, cue_at):
                cue_at = low.find(cue, cue_at + 1)
                continue
            if cue_at < idx:
                if cue_at < idx - window:
                    cue_at = low.find(cue, cue_at + 1)
                    continue  # too far back to reach this token
                if clause_attached(low[cue_at + len(cue):idx]):
                    return -1
                # Other words or a clause boundary separate them: a different clause,
                # so the token keeps its polarity.
                cue_at = low.find(cue, cue_at + 1)
                continue
            # The cue sits AFTER the token. It governs the token only when it is
            # attached to it: "安靜的不好" negates 安靜, while "有無辣，唔好嘈" asks
            # about spicy and refuses noisy - two clauses, and the refusal belongs to
            # the second one. A cue that merely sits somewhere later in the turn
            # governs nothing (D533).
            if clause_attached(low[idx + len(tok):cue_at]):
                return -1
            cue_at = low.find(cue, cue_at + 1)
            continue

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
