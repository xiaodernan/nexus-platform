"""Intent category bucket -> the seeded `categories` taxonomy.

`nexus_ai.nlu.lexicon.match_category` answers with a coarse bucket (`restaurant`,
`escape_room`, `retail`), while `categories.slug` is the merchant taxonomy: 10 roots plus 67
leaves (`restaurant/ramen`, `activity/escape-room`, …). Comparing the two with `=` matched
nothing on a live database — every categorised query returned an empty page — so the bucket is
resolved here into the set of slugs that mean the same thing.

The raw bucket stays in the returned set: `StaticBackend`'s fixture catalogue has no
`categories` rows and stores the coarse bucket in `category` itself, and one code path serves
both backends.
"""

from __future__ import annotations

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
    """Taxonomy slugs hyphenate where the intent vocabulary underscores (`escape_room` ->
    `escape-room`), which covers most buckets without an explicit alias."""
    return bucket.replace("_", "-")


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


__all__ = ["ALIASES", "resolve"]
