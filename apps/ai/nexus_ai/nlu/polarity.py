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

D538 retires the reach that gave this rule a second, contradictory form. Governance is the
clause (D535/D536), and a character count is not a clause: this lane capped a cue's reach at a
fixed number of characters while the constraint lane read the whole clause through the very
same `clause_attached`. The two lanes could therefore disagree about one sentence - "without
海鮮" wrote a refusal of the seafood into the search plan and read it as a LIKE of the seafood
in the ranking, so the product filtered for what it also boosted. The cap was applied to
positions found with `str.find`, so a cue inside a word reached where the ONE matcher would not
have located a cue at all. Both halves go together: one locator, one reach, both lanes. The
agreement the two lanes owe each other is held open by a door in this package's own tests.

The same unit gives the clause a shape the normalizer can no longer erase. A clause comma
used to arrive here as a space, so the two clauses were one string and the boundary this
module already spelled was a rule with nothing left to read: measured, "想食辣，咖喱唔好"
answered -1 for the 咖喱 - a refusal of the very thing the clause before it asked for. The
normalizer now writes CLAUSE_SEPARATOR where the comma was - whitespace, so every `\s*` in
the field rules still reads across it, and not ASCII whitespace, so the fold cannot flatten
it back into one - and the boundary, the filler and the clause-final tail all read it.

The locator this module hands both lanes is `negation_positions`: the matcher's spelling,
minus the two positions where no refusal sits (the existential question's verb, D533, and a
one-character cue that is the tail of another word - 特別 is "especially"). A cue table the
constraint lane reads and this lane does not is the same contradiction in the other
direction, measured on the live service: 避免 / 不吃 / 別 / 少 wrote the plan's `avoid` and
a +1 preference for the value in the same sentence, so the product filtered for what it also
boosted. The vocabulary is one list now, and the boundary rule is what makes the
single-character rows of that list safe to read.

The composition layer is `antonym_direction`. A row may carry its own OPPOSITE in its token
list - the quiet rule carries 嘈 - and then the sign the sentence answers is a sign about the
opposite, not about the value, so the answer owes the value one more reading. D570 wrote the
refusal (唔好嘈 wants quiet). D582 writes the want, and it is not a sign flip: "嘈的餐廳" asks for
the noisy restaurant, so the value points at -1, while "太嘈" and "好嘈" and "有冇嘈" name the
same character without asking for it and keep the row's own +1. What separates them is a FRAME,
not a word - a bridge verb in the surface's own clause before it, the attributive particle in
its clause after it (`is_asked_for`) - because the complaint and the request are written with the
same adjective, and a lane that picks one of them by guessing turns a user's own words into a
dislike of what they asked for. Measured before the arm existed, the want wrote +1 and the
ranking buried the loud half of the live plane (188 quiet merchants scored 1.0, 282 loud ones 0.0)
for the query that asked for the loud half.
"""

from __future__ import annotations

import re
from typing import Any

from nexus_ai.nlu.matching import cue_positions

#: D538: the character the normalizer writes where a clause comma was - the ideographic
#: space. It is whitespace, so every `\s*` in the field rules still reads across it, and
#: it is not ASCII whitespace, so the fold that collapses runs of spaces cannot flatten it
#: back into one. Before it existed the comma became a space and the boundary was gone:
#: "辣，唔好" and "辣 唔好" arrived at the readers as the same string, and nothing
#: downstream could tell a refusal that governs the token before it from the two clauses
#: the user actually wrote.
CLAUSE_SEPARATOR = "\u3000"

#: Negation cues that mean "not this". The Chinese ones are the ones users actually type;
#: the English ones keep the English lexicon rows honest.
#:
#: D534 added 無 and 沒有 - the standard-written refusals, next to the Cantonese 冇 the
#: table already carried: measured, "無素食" read as a LIKE of vegetarian and the ranking
#: lane then boosted it (the D522 shape). 没有 is spelled out beside 沒有 because the
#: canonical table has no 没 -> 沒 entry, so canonicalisation cannot unify the two
#: spellings and a Simplified user's refusal would go unread; the map's hole is filed in
#: PLAN, and when it is filled this row canonicalises into 沒有 and costs nothing.
#:
#: D547 fills that hole: 没 -> 沒 is in the canonical table now, so the two-character rows
#: above canonicalise into 沒有 and the bare 没 joins them as the one-character cue the
#: table already carries 冇 and 無 as. It was the ONE spelling of "did not" the product
#: did not know: measured, "没食辣", "沒食辣", "没吃辣", "沒吃辣", "我没吃辣" and "我沒吃辣"
#: all wrote no constraint and read the cuisine +1 - a LIKE of the very thing the user
#: refused - and answered the intent `unknown`, where 唔食辣 / 不吃辣 / 不想吃辣 / 不要吃辣 /
#: 讨厌吃辣 / 冇食辣 / 無食辣 all write the refusal in both lanes. The bare cue is the same
#: word 冇 and 無 are, in the spelling a Simplified user types; the constraint table reads
#: it through `_CONSTRAINT_NEGATIONS`, which derives from this list, so one entry fixes
#: both lanes (D493's shape).
#:
#: The four refusals the constraint table read and this table did not (D493's debt, the
#: pin D539 armed). Measured on the live service, each of them wrote the plan's `avoid`
#: AND a +1 preference for the same value: "避免海鮮" filtered the seafood out and floated
#: what was left of the seafood to the top, and "不吃辣" / "別推薦辣味" / "少食辣" did the
#: same for the spicy. One vocabulary, read by both lanes (D495's lesson: a fix that takes
#: a SUBSET of the missing words is the same defect it was fixing) - and the single-character
#: rows among them are the reason this table now needs `_completes_a_word`, because 特別 is
#: "especially", not "do not".
NEGATION_CUES: tuple[str, ...] = (
    "唔好", "唔要", "唔想", "唔鍾意", "唔鍾", "唔食", "唔想要", "不要", "不想", "不喜歡", "不喜欢",
    "不想要", "讨厌", "討厭", "没咩", "冇", "無", "沒有", "没有", "没", "唔係", "不是", "不好",
    "不吃", "別", "避免", "少",
    "not ", "no ", "don't", "dont", "do not", "avoid", "without", "hate", "dislike",
)

#: The characters that make a one-character refusal the TAIL of a different word. 別 and
#: 少 refuse a value only when they are the word the user typed; under 特 or 最 they are the
#: second syllable of 特別 ("especially") and 最少 ("at least"). Measured on the live
#: service, the constraint lane already read "特別辣的餐廳" as a refusal of the 辣 - the
#: product filtered out the very thing the user asked for - so widening this table to the
#: single-character cues without the boundary rule would hand the same mistake to the
#: ranking lane too. A cue whose own entry is absent here is read at every position the
#: matcher finds: the rule refuses a compound, not a vocabulary.
NEGATION_COMPOUNDS: dict[str, tuple[str, ...]] = {
    "別": ("特", "分", "個", "性", "識", "告", "送", "差", "闊", "訣", "永", "話", "區", "離"),
    "少": ("多", "最", "缺", "年", "老"),
}

#: D447: the cue table is canonicalised at import, like the lexicon's (D435), the state
#: merger's (D421) and the time parser's (D446). The text is canonicalised before it
#: reaches the polarity, so a Simplified entry here could never match.
#:
#: The Latin entries carry a trailing space, which is how the constraint table spells them
#: too; a reader that locates cues with the ONE matcher strips it first, because "no " is
#: not a word (D538).
_CANONICALISED_TABLES = ("NEGATION_CUES", "NEGATION_COMPOUNDS")


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
#
#: D538: the normalizer's clause separator joins them. It is the character the comma
#: itself became, so the rule reads the same clause edges the user wrote.
#:
#: The characters are written straight into the class - none of them is a regex
#: metacharacter inside brackets - and the newline as its two-character escape, so a
#: reader that walks the class (the doors that derive their population from it) sees a
#: newline where one is meant.
_CLAUSE_BOUNDARY_CHARS = ",，。;；!?！？"
_CLAUSE_BOUNDARY = re.compile(
    "[" + _CLAUSE_BOUNDARY_CHARS + "\\n" + CLAUSE_SEPARATOR + "]")
# D537: the Cantonese sentence-FINAL particles join the vocabulary. A refusal is often
# written with one hanging off the end of it - "辣唔好呀" (spicy, no) - and the after-case
# (a cue that governs the token BEFORE it) has to read the particle as part of the refusal
# rather than as a word the cue is speaking about. Without them the rule below would read
# "辣唔好呀" as a LIKE of the spicy. 咁 came in with D535; these are its neighbours,
# measured against the same need.
#: D538: the whitespace is spelled out - the ASCII space and the tab - because the clause
#: separator is a BOUNDARY, not filler: a gap that holds one is two clauses, and a `\s`
#: here would have read it as the particles' own company.
_LOCAL_FILLER = re.compile(r"[的地得咁咗喇啦呢個個呀㗎喎嘛囉嘞咩啩 \t]*")
_ATTACHED_GAP = 3

#: D582: the particle that turns a property word into the thing a query asks for - "嘈的餐廳",
#: "嘈嘅地方". It is the attributive leg of `is_asked_for`, and 嘅 is the Cantonese spelling of
#: the same function: the product's tables hold the words, and a Hong Kong query joins them with
#: this one. A property word with no particle and no verb after it is a bare mention, and the
#: lane leaves a bare mention alone (`is_asked_for` says what it would otherwise guess).
_ATTRIBUTIVE_PARTICLES = ("的", "嘅")

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

#: D544: the DEGREE adverbs a user puts between a refusal and the thing refused - "not
#: very spicy", "not really like spicy", "唔好 very 辣". A degree word modifies the value;
#: it does not open a clause of its own, so the gap it sits in is the refusal's own. The
#: short ones ("so", "too") were already inside the three-character gap and the Cantonese
#: ones (太, 咁) are the filler class and the short-gap rule's; these are the English words
#: the length rule could not reach. They are read HERE, next to the bridge, because the
#: seam door derives its gap population from the tables this module reads.
_DEGREE_ADVERBS = ("very", "really", "quite", "so", "too")


def clause_attached(between: str) -> bool:
    """Whether a cue and a token separated by `between` are in the same clause.

    D536: the CONSTRAINT lane reads governance through this function too. It had its
    own eight-character window, which is not a clause: measured, it could not reach
    "no coriander" (the value is nine characters) nor "don't want spicy" (one verb
    and two spaces sat in the way), and widening it read "no rush want spicy" as a
    refusal of the spicy. One reader for both lanes, so the two cannot disagree about
    what a refusal governs.
    """
    # D538: the ASCII space and the tab go; the clause separator does not. A plain
    # `.strip()` would have taken it for filler and the boundary would never be read.
    gap = between.strip(" \t")
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
    if gap in _VERB_BRIDGE:
        return True
    # D544: a degree adverb may sit between the cue and the thing it governs - "not very
    # spicy", "唔好 very 辣" - and one may sit between the cue and the bridge verb: "not
    # really like spicy". A word that is neither a degree nor a verb still separates them,
    # which is what keeps D536's "no rush want spicy" unread.
    words = gap.split()
    if words and words[0] in _DEGREE_ADVERBS:
        return len(words) == 1 or (len(words) == 2 and words[1] in _VERB_BRIDGE)
    return False


def _opens_with_verb(gap: str) -> bool:
    """Whether the gap opens with one of the bridge verbs - the next clause's request.

    D540: a verb directly under the separator is what tells a pause from a boundary.
    "唔好，辣" refuses the 辣 (the comma is a pause inside the refusal) while "唔好，要辣"
    asks for it (the comma ended the cue's clause and 要 opens the next one). A Latin verb
    is a WORD - "wanted" does not open with "want" - and a Chinese one is the character.
    """
    for verb in _VERB_BRIDGE:
        if verb.isascii():
            if re.match(re.escape(verb) + r"\b", gap):
                return True
        elif gap.startswith(verb):
            return True
    return False


def forward_gap(low: str, cue_end: int, token_at: int) -> str:
    """The gap between a cue and the token it governs, with the cue's own punctuation gone.

    D538: the normalizer writes a clause separator where a comma was, and one that sits
    directly under the cue is the cue's own punctuation - "唔好，辣" refuses the 辣, the
    comma is a pause after the refusal, not a boundary between it and its object. A
    separator anywhere else in the gap is the boundary between two clauses, and
    `clause_attached` reads it as one. So the leading run goes and the rest is read as it
    stands. This is the forward direction only: a cue that governs a token BEFORE it - the
    after-case - keeps every separator in its gap, because there the comma really did end
    the token's clause ("辣，唔好" leaves the 辣 alone).

    D540: the separator is the cue's own punctuation only when the cue's OBJECT follows
    it. A gap that opens with a verb after the separator is the next clause asking for
    something - "唔好，要辣" asks for the 辣 and "咖喱唔好，想食辣" asks for the 辣 it also
    refuses the curry in - so the separator stays in the gap and `clause_attached` reads
    the boundary. Only a STRIPPED separator arms this, and only against a verb: the
    bridge inside one clause ("唔好要辣", no comma) still refuses the 辣, because there was
    no separator to read and the verb is the clause's own (D535).
    """
    raw = low[cue_end:token_at]
    gap = raw.lstrip(" \t" + CLAUSE_SEPARATOR)
    if gap == raw:
        return raw
    prefix = raw[:len(raw) - len(gap)]
    if CLAUSE_SEPARATOR in prefix and _opens_with_verb(gap):
        return raw
    return gap


def _governed_by_verb(tail: str) -> bool:
    """Whether the cue governs a verb - the topicalised refusal's other half.

    D543: a refusal can put the value FIRST and the verb after the cue - "花生少吃"
    (peanut, eat less), "gluten 避免吃" (avoid eating gluten), "牛肉唔好食" (beef, do
    not eat). The cue governs the verb, and the verb's object is the token the
    backward arm found before the cue. A NOUN after the cue is still the cue's own
    object (D537: "no cilantro" keeps the cilantro), and a verb with words of its own
    after it ("唔好食咖喱") is the forward refusal of those words instead - so the tail
    is ONE bridge verb, with the clause's own particles allowed to hang off it.
    """
    for verb in _VERB_BRIDGE:
        if verb.isascii():
            m = re.match(re.escape(verb) + r"\b", tail)
            if m is None:
                continue
            rest = tail[m.end():]
        elif tail.startswith(verb):
            rest = tail[len(verb):]
        else:
            continue
        rest = rest.strip(" \t")
        return not rest or _LOCAL_FILLER.fullmatch(rest) is not None
    return False


def clause_final(low: str, cue_at: int, cue: str) -> bool:
    """Whether nothing but the clause's own particles follows the cue.

    D537: a cue that still has words after it is speaking about THOSE words. Measured,
    "I want spicy no cilantro" answered spicy **-1** - a dislike of the very thing the
    user asked for, which the ranking lane then demoted (the D522 shape, in the
    after-case) - because the "no" sits directly after the token with nothing between
    them, and the reader took an empty gap for governance. The "no" governs the cilantro
    that follows it. A cue governs a preceding token only when it governs nothing after
    it: "素食唔好" refuses the 素食, "辣唔好呀" refuses the 辣, and the cue with an object
    of its own keeps its object.

    D538: the tail is the cue's OWN CLAUSE, not the rest of the turn. "安靜的不好，要嘈"
    refuses the 安靜 and asks for the 嘈, and a reader that ran to the end of the sentence
    answered +1 for the 安靜 - the refusal's own clause ended at the comma and the words
    after it belong to the next one. The tail now ends at the clause boundary, which is
    where the cue's clause ends.

    D543: ONE verb may follow the cue without being the cue's object, because the
    refusal written the eat-less way puts the verb after it - "花生少吃", "peanut 別吃",
    "gluten 避免吃". The verb's object is the token before the cue, which is exactly
    what the backward arm is asking about, so the cue is final enough for it. A verb
    with an object of its own after it is the forward refusal of that object, and the
    tail check refuses it.
    """
    tail = low[cue_at + len(cue):]
    boundary = _CLAUSE_BOUNDARY.search(tail)
    if boundary is not None:
        tail = tail[:boundary.start()]
    tail = tail.strip(" \t")
    if _LOCAL_FILLER.fullmatch(tail) is not None:
        return True
    return _governed_by_verb(tail)


#: D533: the lead of the existential question. 有冇 / 有無 / 有没有 all ask "is there
#: any", and the cue that follows the 有 is the question's verb, not a refusal - so a
#: cue sitting directly under a 有 governs nothing.
_EXISTENTIAL_LEAD = "有"


def is_existential_question(low: str, cue_at: int) -> bool:
    """Whether the cue at `cue_at` is the tail of 有冇 / 有無 / 有没有 - a question, not a refusal."""
    lead = cue_at - len(_EXISTENTIAL_LEAD)
    return lead >= 0 and low[lead:cue_at] == _EXISTENTIAL_LEAD


def _completes_a_word(cue: str, text: str, cue_at: int) -> bool:
    """Whether the cue at `cue_at` is the second syllable of a longer, different word."""
    if len(cue) != 1 or cue.isascii():
        return False
    compounds = NEGATION_COMPOUNDS.get(cue)
    if not compounds:
        return False
    return cue_at > 0 and text[cue_at - 1] in compounds


def negation_positions(cue: str, text: str, low: str) -> list[int]:
    """Where a refusal reads in the text - the ONE locator both lanes ask.

    The matcher answers where a cue's SPELLING sits (D478/D538); this answers where a
    refusal is. Two positions the bare matcher finds and no refusal lives at: a cue under
    the lead of the existential question - 有冇 X asks whether X exists (D533) - and a
    one-character cue that is the tail of another word - 特別 is "especially". Both lanes
    read the refusal through here, so the plan's `avoid` list and the ranking's polarity
    cannot disagree about one position the way they could not disagree about one clause
    (D536/D538).
    """
    return [at for at in cue_positions(cue, text, low)
            if not is_existential_question(low, at)
            and not _completes_a_word(cue, text, at)]


def polarity_for(text: str, token: str) -> int:
    """+1 when the preference is wanted, -1 when it is negated, 0 when it is ungoverned.

    The token's own position decides. A cue ATTACHED to the token - immediately before
    or after it, modulo a short in-clause gap - governs that token and nothing else. A
    cue elsewhere in the sentence governs the turn only when no clause boundary and no
    more than a short gap separates it from the token; otherwise the two belong to
    different clauses and the token keeps its positive polarity. A cue under the lead of
    the existential question (有冇 X) governs nothing at all (D533).

    D538: the positions come from the ONE matcher and the reach is the clause - the two
    rules the constraint lane already reads. A cue inside a word is not a cue, and a cue
    cannot reach further back than the clause it sits in, so the lanes cannot part company
    over one sentence: a refusal the search filters for is never also a preference the
    ranking boosts.
    """
    low = text.lower()
    tok = token.strip().lower()
    if not tok:
        return 0

    found = cue_positions(tok, text, low)
    if not found:
        return 0
    idx = found[0]

    for cue in NEGATION_CUES:
        # The table's Latin entries carry their own trailing space; the matcher wants the
        # word. The same reading of the same table the constraint lane makes (D536).
        c = cue.strip()
        if not c:
            continue
        # Every occurrence, not just the first: "有冇辣，冇海鮮" asks about spicy and
        # refuses seafood, and a reader that stops at the first 冇 answers neither.
        for cue_at in negation_positions(c, text, low):
            # The cue must not sit inside the preference token itself.
            if idx <= cue_at < idx + len(tok):
                continue
            if cue_at < idx:
                if clause_attached(forward_gap(low, cue_at + len(c), idx)):
                    return -1
                # Other words or a clause boundary separate them: a different clause,
                # so the token keeps its polarity.
                continue
            # The cue sits AFTER the token. It governs the token only when it is
            # attached to it: "安靜的不好" negates 安靜, while "有無辣，唔好嘈" asks
            # about spicy and refuses noisy - two clauses, and the refusal belongs to
            # the second one. A cue that merely sits somewhere later in the turn
            # governs nothing (D533), and a cue with an object after it governs THAT
            # object, not the token before it (D537).
            if (clause_attached(low[idx + len(tok):cue_at])
                    and clause_final(low, cue_at, c)):
                return -1

    return 1


def _first_position(text: str, token: str) -> int:
    """Where the reader reads the token from - its first position, or -1 for nowhere.

    `polarity_for` reads the token at `cue_positions(...)[0]`; a second reader of the same
    sentence has to mean the same occurrence, or the two answer two different words (D541).
    """
    low = text.lower()
    tok = token.strip().lower()
    if not tok:
        return -1
    found = cue_positions(tok, text, low)
    return found[0] if found else -1


def is_asked_about(text: str, token: str) -> bool:
    """Whether the token is what 有冇 / 有無 / 有没有 asks about - a question, not a want.

    D533 answered this SHAPE for the CUE: a 冇 sitting directly under a 有 is the question's
    own verb, so it refuses nothing (`is_existential_question`). Read at the TOKEN instead,
    the same shape is the question's object: "有冇嘈" asks whether a noisy place exists, and
    neither a refusal nor a want is in it. The positions come from the ONE matcher and the
    predicate is D533's own, so the two readers cannot name two different words for one 冇 -
    and this is the complement of `negation_positions`, which is exactly where a refusal is
    NOT, for the same reason.
    """
    tok_at = _first_position(text, token)
    if tok_at <= 0:
        return False
    low = text.lower()
    for cue in NEGATION_CUES:
        c = cue.strip()
        if not c:
            continue
        for cue_at in cue_positions(c, text, low):
            if cue_at + len(c) == tok_at and is_existential_question(low, cue_at):
                return True
    return False


def is_asked_for(text: str, token: str) -> bool:
    """Whether the sentence asks FOR the token - the frame that turns a word into a want.

    Two shapes carry it, and both are vocabulary this module already reads: a bridge verb
    (`_VERB_BRIDGE` - 想 / 要 / 食 / want / like) in the token's OWN CLAUSE before it, and the
    attributive particle (`_ATTRIBUTIVE_PARTICLES` - 的 / 嘅) in its own clause after it.
    "我想嘈一點" and "嘈嘅餐廳" both ask for the noise; "太嘈" asks for nothing, and neither
    shape is in it.

    The frame is why the want of an antonym is decided by the SENTENCE and not by a marker
    table. Measured, "好嘈", "咁嘈", "嘈死" and "嘈到爆" name the noise with no governance at
    all, and they are complaints about a place as often as they are requests for one; so is
    "我想搵好嘈嘅餐廳", which the same words make into a want. No word inside those sentences
    says which, and a lane that guesses turns a request into a dislike of the thing asked
    for - so a bare mention is left at the row's own polarity, which is what the product did
    before this rule and what its tests pin.
    """
    tok_at = _first_position(text, token)
    if tok_at < 0:
        return False
    low = text.lower()
    tok_end = tok_at + len(token.strip().lower())

    head = low[:tok_at]
    cut = 0
    for boundary in _CLAUSE_BOUNDARY.finditer(head):
        cut = boundary.end()
    for verb in _VERB_BRIDGE:
        if verb.isascii():
            if re.search(r"\b" + re.escape(verb), head[cut:]):
                return True
        elif verb in head[cut:]:
            return True

    tail_m = _CLAUSE_BOUNDARY.search(low, tok_end)
    tail = low[tok_end:tail_m.start()] if tail_m else low[tok_end:]
    return any(p in tail for p in _ATTRIBUTIVE_PARTICLES)


def antonym_direction(sign: int, text: str, token: str) -> int:
    """Which way a value's OPPOSITE surface points the VALUE.

    `polarity_for` answers what the sentence does to the surface; this answers what the
    surface does to the value, for the row that carries its own opposite in its token list
    (`lexicon.ANTONYM_TERMS`: the quiet rule carries 嘈). Four readings, and the value is
    pointed at by three of them:

      * a REFUSAL of the opposite wants the value - "唔好嘈" wants quiet (D570);
      * an EXISTENTIAL QUESTION about it says neither, so it stays where the row put it, +1
        - 有冇嘈 asks, it does not want (D533, pinned by D570's own test);
      * a sentence that ASKS FOR it is a dislike of the value - "嘈的餐廳" wants the noisy
        restaurant, so quiet points at -1 and the ranking demotes the quiet ones. Measured
        before this arm existed the query wrote +1, and on the live plane the ranker scored
        the 188 merchants whose `quiet_ambience` is True at 1.0 and the 282 whose it is
        False at 0.0: the loud half of the plane was buried for the user who asked for it;
      * anything else is a bare mention, ungoverned and frameless, and the lane does not
        guess its direction (`is_asked_for` says why).

    `polarity_for` is unchanged: the pure cue reader still answers -1 for "唔好咁嘈", which
    is what its own tests pin. This is the composition layer, where the (key, value) is
    known.
    """
    if sign == -1:
        return 1
    if sign == 1 and not is_asked_about(text, token) and is_asked_for(text, token):
        return -1
    return sign


def apply_polarity(preferences: list[dict[str, Any]], text: str,
                    tokens: dict[tuple[str, str], str] | None = None) -> list[dict[str, Any]]:
    """Re-stamp each preference's polarity from the sentence it came from.

    The lexicon's fixed polarity is the default; the sentence overrides it only when it
    actually negates the preference. `tokens` maps a preference's (key, value) to the
    surface token that matched it in the sentence — the canonical value ("quiet") is not
    in a Chinese sentence, but the token that matched ("安靜") is.

    A token that is the value's OWN OPPOSITE is read by `antonym_direction`, which is the
    one place that knows both the (key, value) and the surface, so both directions of the
    inversion live in one function instead of one in each reader (D570, D582).

    Also deduplicates preferences by (key, value) keeping the first occurrence.
    """
    from nexus_ai.nlu.lexicon import ANTONYM_TERMS

    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for pref in preferences:
        key = str(pref.get("key") or "")
        value = str(pref.get("value") or "")
        if (key, value) in seen:
            continue
        seen.add((key, value))
        token = ""
        if tokens is not None:
            token = tokens.get((key, value), "")
        if not token:
            token = value or key
        if token and token.lower() in text.lower():
            sign = polarity_for(text, token)
            if token.strip().lower() in ANTONYM_TERMS.get((key, value), frozenset()):
                sign = antonym_direction(sign, text, token)
            if sign:
                pref = {**pref, "polarity": sign}
        out.append(pref)
    return out
