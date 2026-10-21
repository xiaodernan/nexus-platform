"""Contract tests for ``nexus_ai.search.tokens`` — query vocabulary + containment (§7, RAG).

The module exists because a Chinese query carries no spaces (a bare split yields one enormous
token that matches nothing) and because trigram similarity does NOT separate a real match from
noise (a real 咖啡 match measured 0.0063 vs 0.0093 for nonsense). Containment — "does the text
hold the words?" — is the honest signal, so it is pinned here.

Pure and DB-free.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

import nexus_ai.search.tokens as T


class TestCjkBigrams:
    def test_all_bigrams_in_order(self):
        assert T.cjk_bigrams("沙田餐廳") == ["沙田", "田餐", "餐廳"]

    def test_two_chars_is_one_bigram(self):
        assert T.cjk_bigrams("咖啡") == ["咖啡"]

    def test_single_char_has_no_bigram(self):
        assert T.cjk_bigrams("a") == []
        assert T.cjk_bigrams("咖") == []

    def test_empty(self):
        assert T.cjk_bigrams("") == []

    def test_latin_is_ignored_and_cjk_extracted(self):
        assert T.cjk_bigrams("a沙田b") == ["沙田"]


class TestQueryTokens:
    def test_mixed_cjk_and_latin(self):
        assert T.query_tokens("咖啡 shop") == ["咖啡", "shop"]

    def test_single_char_latin_dropped(self):
        assert T.query_tokens("a 沙田") == ["沙田"]

    def test_empty_and_none(self):
        assert T.query_tokens("") == []
        assert T.query_tokens(None) == []

    def test_punctuation_stripped_and_lowercased(self):
        assert T.query_tokens("Hello, World!") == ["hello", "world"]

    def test_duplicates_removed_preserving_order(self):
        assert T.query_tokens("咖啡 咖啡") == ["咖啡"]


class TestMentions:
    def test_cjk_containment_true(self):
        assert T.mentions("我喜歡咖啡", "咖啡") is True

    def test_latin_containment_true(self):
        assert T.mentions("Ramen House", "ramen") is True

    def test_cross_language_is_false(self):
        # the text is latin, the query is Chinese -> no containment
        assert T.mentions("The coffee shop", "咖啡") is False

    def test_single_char_query_matches_nothing(self):
        # a one-character query cannot be told apart from any other -> honest False
        assert T.mentions("x", "咖") is False

    def test_empty_query_matches_nothing(self):
        assert T.mentions("abc", "") is False


class TestCjkKeywords:
    def test_short_word_kept_whole(self):
        assert T.cjk_keywords("咖啡") == ["咖啡"]

    def test_latin_excluded(self):
        assert T.cjk_keywords("咖啡 shop") == ["咖啡"]

    def test_long_run_becomes_bigrams(self):
        assert T.cjk_keywords("幫我找沙田的餐廳") == [
            "幫我", "我找", "找沙", "沙田", "田的", "的餐", "餐廳",
        ]

    def test_limit_zero_is_empty(self):
        assert T.cjk_keywords("咖啡", limit=0) == []

    def test_limit_one(self):
        assert T.cjk_keywords("咖啡", limit=1) == ["咖啡"]

    def test_keyword_max_len_constant(self):
        assert T.KEYWORD_MAX_LEN == 4
