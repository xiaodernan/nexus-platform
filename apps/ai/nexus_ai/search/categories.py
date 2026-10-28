"""Intent category bucket -> the seeded `categories` taxonomy.

`nexus_ai.nlu.lexicon.match_category` answers with a coarse bucket (`restaurant`,
`escape_room`, `retail`), while `categories.slug` is the merchant taxonomy: 10 roots plus 67
leaves (`restaurant/ramen`, `activity/escape-room`, …). Comparing the two with `=` matched
nothing on a live database — every categorised query returned an empty page — so the bucket is
resolved here into the set of slugs that mean the same thing.

The raw bucket stays in the returned set: `StaticBackend`'s fixture catalogue has no
`categories` rows and stores the coarse bucket in `category` itself, and one code path serves
both backends.

The same rule reads the merchant `tags` column. The seed writes every tag as a lowercase
hyphen slug (all 100 distinct tags in the demo corpus match `^[a-z0-9-]+$`) and the SQL tag
filter compares with `&&` - an exact array overlap - so the caller's spelling has to be folded
into that one spelling before it reaches the predicate.
"""

from __future__ import annotations

import re

#: the one separator rule: the vocabulary separates words with `_` or a space, a slug
#: hyphenates them.
_SEPARATORS = re.compile(r"[\s_]+")

#: buckets whose name is not a slug in the taxonomy, i.e. not fixed by `_slug()` alone.
ALIASES: dict[str, tuple[str, ...]] = {
    "afternoon_tea": ("tea-house", "cha-chan-teng"),
    "bakery": ("bakery-dessert",),
    "cooking_class": ("craft-workshop",),
    "gym": ("gym-club",),
    "pet": ("pet-grooming",),
    "yoga": ("yoga-pilates",),
    "attraction": ("experience", "activity"),
    "retail": ("shopping",),
}


def _slug(bucket: str) -> str:
    """The product's ONE separator rule: a slug hyphenates where the vocabulary separates
    words (`escape_room` -> `escape-room`, `escape room` -> `escape-room`), which covers most
    buckets and tags without an explicit alias."""
    return _SEPARATORS.sub("-", bucket)


def canonical_tag(tag: str | None) -> str:
    """The stored spelling of a tag: case-folded, trimmed, separators hyphenated.

    The seed is the writer and the SQL `&&` predicate is the reader; this is the one function
    that speaks to both. It RESPELLS and never REWORDS - there is no alias table and no
    lexicon here - so a tag the product does not know keeps its word and still matches
    nothing, rather than being resolved into a different tag the caller never asked for.
    """
    return _slug((tag or "").strip().lower())


def _spellings(value: str | None) -> list[str]:
    """Every spelling of ONE word the product's readers use: as typed, hyphenated, underscored.

    The lexin's cuisine bridge is keyed on the intent vocabulary's underscore form (`dim_sum`)
    while the corpus writes the hyphenated slug (`dim-sum`), so a reader that offers it only
    one of the two can miss the leaf. The space-separated prose form ("dim sum") folds to the
    hyphenated one first, and that in turn yields the underscored one, so all three land on
    the bridge.
    """
    raw = (value or "").strip().lower()
    if not raw:
        return []
    out = [raw]
    for form in (canonical_tag(raw), canonical_tag(raw).replace("-", "_")):
        if form and form not in out:
            out.append(form)
    return out


def avoid_terms(value: str | None) -> list[str]:
    """The spellings an `avoid` value stands for, in the corpus's own vocabulary.

    `plan.avoid` carries the lexin's canonical constraint value - the negation reader turns a
    Cantonese "no seafood" into `seafood` - and the SQL avoid clause compares that token to
    `m.category_primary` with `=` and to the offering names with ILIKE. The taxonomy's leaf for
    the same word is `seafood-grill`, and the column stores the leaf's NAME ("Seafood & BBQ"),
    so neither leg can fire: measured on the live corpus, all 14 published merchants tagged
    `seafood-grill` survived `avoid=["seafood"]`.

    The leaves come from the lexin's OWN cuisine bridge (`cuisine_leaves`) - the same reader
    the preference lane reads a cuisine with (D394) - so one word has one set of spellings
    again. A cuisine the taxonomy does not know still contributes its own spellings, because
    that is a word a merchant may carry in its tags.
    """
    from nexus_ai.nlu.lexicon import cuisine_leaves

    out: list[str] = []
    for spelling in _spellings(value):
        for term in (spelling, *cuisine_leaves(spelling)):
            if term and term not in out:
                out.append(term)
    return out


#: The aspect names a refusal stands for in the corpus's own attribute vocabulary.
#: `weak_aspects` is the LIST of aspect names a merchant is weak at (the seed writes
#: `noise`, `service`, `waiting_time`, ...). The lexin's constraint values and the corpus's
#: aspect names are two vocabularies for the same fact, and `queue` is the one pair whose
#: spelling differs. `smoking` has no entry because no reader may exclude on a fact the
#: corpus does not write - the generator records no smoking attribute at all.
ASPECT_AVOID: dict[str, tuple[str, ...]] = {
    "noise": ("noise",),
    "queue": ("waiting_time",),
}


def aspect_terms(value: str | None) -> list[str]:
    """The `weak_aspects` names a refused constraint stands for, deduped and order-stable.

    Measured on the live plane at HEAD (2026-10-28): `avoid=["noise"]`, `["queue"]` and
    `["smoking"]` each removed **0** of 470 published merchants, while the corpus records the
    fact for two of them - `weak_aspects` names `noise` on 15 merchants and `waiting_time` on
    15. The refusal surface exists and the fact exists; nothing joined them.
    """
    out: list[str] = []
    for spelling in _spellings(value):
        for term in ASPECT_AVOID.get(spelling, ()):
            if term not in out:
                out.append(term)
    return out


def resolve(bucket: str | None) -> list[str]:
    """Slugs standing for `bucket`, deduped, order-stable. Empty when nothing was asked."""
    if not bucket:
        return []
    b = bucket.strip().lower()
    if not b:
        return []
    out: list[str] = []
    for s in (b, _slug(b), *ALIASES.get(b, ())):
        if s not in out:
            out.append(s)
    return out


__all__ = ["ALIASES", "ASPECT_AVOID", "aspect_terms", "avoid_terms",
           "canonical_tag", "resolve"]
