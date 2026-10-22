"""What a query asks about, and whether a text mentions it (§7, RAG).

Two things live here, and the second exists because of the first:

1. `query_tokens` — the words and CJK bigrams a query asks about. Chinese has no
   spaces, so a bare `split()` yields one enormous token that matches nothing; the
   bigrams are what a chunk can actually contain (the house's existing
   `_static_tokens` did this for the offline catalogue, and the live lanes need the
   same vocabulary).

2. `mentions` — whether a text mentions what the query asks about.

**Why the second is not the first.** The trigram `similarity()` of a long chunk against a
short query is a tiny number, and it does NOT separate a real match from noise: measured
on the seeded corpus, 咖啡 (a real match, 79 chunks contain it) scores **0.0063** while a
nonsense query scores **0.0093** — the noise is HIGHER. So similarity can widen a
candidate set (which is what it is used for) but it can never be a confidence signal.
Containment can: the chunk's text either has the words or it does not.
"""

from __future__ import annotations

from nexus_ai.nlu.matching import cue_in

#: CJK ideographs, the range `normalize_query` and the lexicon both use.
_CJK_LO, _CJK_HI = "一", "鿿"


def _clean(token: str) -> str:
    """Drop the punctuation, keep the letters and the CJK."""
    return "".join(ch for ch in token if ch.isalnum())


def cjk_bigrams(text: str) -> list[str]:
    """The CJK bigrams of a text — the unit a Chinese chunk can actually hold.

    One rule, owned here: the offline catalogue matcher (`search/service.py`) used to
    carry its own copy of the CJK range, and a second copy of a range is how the two
    lanes start disagreeing about what a Chinese word is.
    """
    cjk = "".join(ch for ch in text if _CJK_LO <= ch <= _CJK_HI)
    if len(cjk) < 2:
        return []
    return [cjk[i:i + 2] for i in range(len(cjk) - 1)]


def query_tokens(text: str | None) -> list[str]:
    """The words and CJK bigrams a query asks about.

    Latin words are kept whole (a whole word is what a text contains); a CJK run is
    additionally broken into bigrams, because a Chinese query carries no spaces and the
    bigram is the unit a chunk can hold.
    """
    low = (text or "").lower()
    out: list[str] = []
    for word in low.split():
        cleaned = _clean(word)
        if len(cleaned) >= 2:
            out.append(cleaned)
        out.extend(cjk_bigrams(word))
    return list(dict.fromkeys(out))


def mentions(text: str, query: str | None) -> bool:
    """Whether a text mentions what the query asks about.

    A query token of two characters or more has to appear in the text. A query with
    nothing tokenizable (a single CJK character, a punctuation mark) matches nothing:
    "mentions" has to mean something, and a one-character query cannot be told apart
    from any other one.
    """
    low = (text or "").lower()
    for token in query_tokens(query):
        # D482: the ONE matcher - the query's token is a WORD in the text. "spa" inside
        # "spaghetti" is not a spa, and "tea" inside "steakhouse" is not a tea. A
        # plural still matches: "bar" in "bars" is a bar.
        if cue_in(token, text or "", low):
            return True
    return False


#: A Chinese word is short. Four characters is the house's line between a keyword
#: (咖啡, 燒鵝飯) and a phrase (幫我找沙田的餐廳), and the line matters because a long
#: run contributes only its BIGRAMS to a keyword list: a phrase is not a thing a
#: merchant's text can contain.
KEYWORD_MAX_LEN = 4


def cjk_keywords(text: str | None, limit: int = 16) -> list[str]:
    """The Chinese words a query names — short runs whole, long runs as their bigrams.

    The merchant lane's containment needs a WORD list, not the raw query: a merchant's
    text can contain 咖啡 but never the whole sentence the user typed. The order is the
    query's own order and the list is capped, so a long utterance cannot turn the
    candidate query into a hundred `strpos` calls per row.
    """
    out: list[str] = []
    seen: set[str] = set()
    for token in query_tokens(text):
        if not any(_CJK_LO <= ch <= _CJK_HI for ch in token):
            continue  # a latin word: the tsvector lane already reads it
        pieces = ([token] if len(token) <= KEYWORD_MAX_LEN
                  else [token[i:i + 2] for i in range(len(token) - 1)])
        for piece in pieces:
            if piece and piece not in seen:
                seen.add(piece)
                out.append(piece)
    return out[:limit]


__all__ = ["cjk_bigrams", "cjk_keywords", "mentions", "query_tokens"]
