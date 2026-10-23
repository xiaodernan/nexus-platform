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


__all__ = ["ALIASES", "canonical_tag", "resolve"]
