"""D642 - every CTA the card prints is a verb and a path the published block publishes.

`EntityCard.actions` is an array of `$defs/CardAction` (`packages/types/src/schemas/entity_card.json`),
and that block is closed: `additionalProperties: false`, `required: [type, label, endpoint]`, a
pattern on `endpoint` (`^(/api/v1/|/checkout/|https://)`) and an enum on `type` - the 11 words of
`CARD_ACTION_TYPE` (`packages/types/src/enums.ts:191`), whose description says "unknown values are
rejected on the wire (AGENT_CONTRACT §3 'unknown values are hard errors')".

`build_actions` spelled its verbs from a DIFFERENT registry. `view` and `cart_add` are AGENT_CONTRACT
§10 *event* names (`docs/AGENT_CONTRACT.md:181`, the same words `V1__init.sql:768` comments on
`events.name` and `event.json` requires), and `ask` is in no registry at all; the block's words for
those three CTAs are `view_menu`, `add_to_cart` and `message`. Its endpoints were the AI lane's own
doors, `/ai/v1/merchant-agent/chat` and `/ai/v1/compare`, which the block's pattern refuses and whose
own description refuses in prose: "always a platform path (`/api/v1/...`), never an `/ai/v1/...`
path, because mutations go through the platform with a scoped token (API_CONTRACT §0, DECISIONS D5)".
`tmp/cta_offences.mjs` judged the census `tmp/cta_dump.py` captured in-process (60 served cards, 151
actions: 6 demo / 14 actions, 54 live / 137) and the 12 builder shapes (4 row shapes x 3 locales):
**60 of 60 served cards and 12 of 12 shapes offend**, and 81 of the 151 endpoints are `/ai/v1/...`.

Three more the pattern could not see, all measured on the same dump:

  * the browse CTA is `/api/v1/merchants/{rec["slug"]}`, and on the offering lane that is the
    OFFERING's slug (`search/sql.py:576`; the owner is carried separately as `merchant_slug`, `:581`
    and `api/demo_data.py:121`). `tmp/cta_slugcheck.py` asked the live tables which slug is in which
    table: **9 of the 54 live merchant paths are offering slugs** (`preserved-fruit-gift-set` x3,
    `tea-gift-box`, `kids-cut-small`, `ginseng-chicken-soup`, one each of two more `preserved-fruit`
    variants and `blind-bottle-deal-small`), plus 1 of the 6 demo ones, and `requireRow` answers them
    with `ApiException.notFound("merchant_not_found")` (`CatalogController.java:484-488`);
  * `compare` had an endpoint but the block makes it the client-side-only action - `endpoint` is
    `["string","null"]` and `packages/types/fixtures/entity_card.json:47` sends `null` - which the
    Python model could not have sent anyway, because it declared `endpoint: str`;
  * the agent CTA's label was `L["view"]`, so a card with an agent printed two buttons reading 查看
    next to each other - the only place 查看 and 比較 are produced together as action labels is this
    dict (`grep -rn` over `apps` and `packages`), and a Playwright accessibility snapshot this machine
    still holds under `tests/e2e/report/data/`, from the failed compare-table leg of
    `specs/consumer/vertical-slice.spec.ts`, renders `button "查看"`, `button "查看"`, `button "比較"` on
    one Noodle & Rice Diner card, four such pairs on that page.

The block publishes seven keys - `type`, `label`, `endpoint`, `method`, `requires_auth`, `secondary`,
`payload` - and this lane's `CardAction` declares four of them, so the three that tell a client how to
knock (`packages/types/fixtures/entity_card.json:46` sends `"method": "POST", "requires_auth": true` on
its reserve CTA, and `:47` sends `"secondary": true` with the null endpoint) cannot be sent from here at
all. That gap is pinned below rather than fixed: the doors chosen here are POSTs
(`ConversationController.java`, `CartController.java`, `ReservationController.java` each carry
`@RequiresAuth`), and what a card says about them is the next unit's measure.

`/api/v1/conversations` is the platform's door for the same question: `API_CONTRACT.md:325` gives it
`{merchant_id?, channel, mode}`, and `ConversationService.java:78-79` defaults `channel` to `web` and
`mode` to `ai` - so the merchant's agent is what answers there, and the payload the card already
sends is the whole body it needs.

The yardstick is `packages/types/src/schemas`, the tracked half (`git ls-files packages/types/dist`
answers 0 files, so `dist` is a build product).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import CardAction
from nexus_ai.search.cards import build_actions

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

CARD = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "entity_card.json")
                  .read_text(encoding="utf-8"))
BLOCK = CARD["$defs"]["CardAction"]
ACTION_WORDS = set(CARD["$defs"]["CardActionType"]["enum"])
PROPS = set(BLOCK["properties"])
REQUIRED = set(BLOCK["required"])
ENDPOINT_PATTERN = re.compile(BLOCK["properties"]["endpoint"]["pattern"])

SUBJ = UUID("33333333-3333-3333-3333-333333333333")
MERCHANT = "lan-kwai-fong"
OFFERING = "preserved-fruit-gift-set"

#: the four row shapes the builder can be handed, at the locale the census served them in. Each
#: carries the columns the offering lane's SELECT actually names, because that is what decides
#: whether the browse CTA prints a merchant slug.
SHAPES: dict[str, tuple[str, dict]] = {
    "merchant with an agent": ("merchant", {"slug": MERCHANT, "ai_agent_enabled": True}),
    "merchant": ("merchant", {"slug": MERCHANT}),
    "bookable offering": ("product", {"slug": OFFERING, "kind": "product", "bookable": True,
                                      "merchant_id": str(SUBJ), "merchant_slug": MERCHANT}),
    "offering": ("service", {"slug": "kids-cut-small", "kind": "service", "bookable": False,
                             "merchant_id": str(SUBJ), "merchant_slug": MERCHANT}),
}


def _actions(name: str, locale: str = "zh-HK") -> list[dict]:
    card_type, rec = SHAPES[name]
    return [a.model_dump(mode="json") for a in build_actions(card_type, SUBJ, rec, locale)]


def _assert_accepted(where: str, actions: list[dict]) -> None:
    assert actions, f"{where} sent no action at all"
    for i, a in enumerate(actions):
        extra = sorted(set(a) - PROPS)
        assert not extra, (f"{where} actions[{i}] carries {extra}, and CardAction sets "
                           f"additionalProperties=false")
        missing = sorted(REQUIRED - set(a))
        assert not missing, f"{where} actions[{i}] omits the required keys {missing}"
        assert a["type"] in ACTION_WORDS, (
            f"{where} actions[{i}] sends type={a['type']!r}, which is not one of "
            f"{sorted(ACTION_WORDS)}")
        endpoint = a.get("endpoint")
        if endpoint is not None:
            assert ENDPOINT_PATTERN.match(endpoint), (
                f"{where} actions[{i}] sends endpoint={endpoint!r}, which does not match "
                f"{BLOCK['properties']['endpoint']['pattern']}")


def _cards_from(database_url: str) -> list[dict]:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=database_url, internal_token="")
    with TestClient(create_app(settings)) as client:
        out = []
        # the merchant plane and the offering plane: `filters.kind` is the reader that puts
        # `subject_types` on the offering lane (`search/service.py:675`), and the six queries of the
        # D619 census answered only merchants, so the two offering branches were never served once.
        for body in ({"query": "browse restaurant", "limit": 6},
                    {"query": "ramen", "filters": {"kind": "service"}, "limit": 6},
                    {"query": "gift set", "filters": {"kind": "product"}, "limit": 6}):
            r = client.post("/ai/v1/search", json=body)
            assert r.status_code == 200, r.text
            out.extend(r.json()["items"])
    return out


def test_the_published_block_still_is_the_yardstick_this_gate_reads():
    # a door that reads a schema must notice when the schema moves under it
    assert BLOCK["additionalProperties"] is False
    assert REQUIRED == {"type", "label", "endpoint"}
    assert ACTION_WORDS == {"reserve", "buy", "add_to_cart", "view_menu", "view_reviews",
                            "compare", "message", "direction", "share", "external_link", "follow"}
    assert "null" in BLOCK["properties"]["endpoint"]["type"], (
        "the block no longer makes an endpoint optional-in-value, so `compare`'s null is now "
        "an offence and this door has to be re-read, not left asserting the old shape")
    assert "/ai/v1" not in ENDPOINT_PATTERN.pattern
    assert "never an `/ai/v1/...` path" in BLOCK["description"]


def test_the_model_declares_no_key_the_block_refuses_and_carries_what_required_asks():
    fields = set(CardAction.model_fields)
    extra = sorted(fields - PROPS)
    assert not extra, (f"`CardAction` declares {extra}, keys the block does not have - the wire "
                       f"would send them")
    assert REQUIRED <= fields, f"the model cannot send the required keys {sorted(REQUIRED - fields)}"


def test_the_three_keys_the_block_allows_are_not_sendable_from_here():
    # a declared disagreement, not a pass: the block publishes these three and the shipped fixture
    # uses them, so a card cannot tell its reader that three of its doors are authenticated POSTs
    undeclared = sorted(PROPS - set(CardAction.model_fields))
    assert undeclared == ["method", "requires_auth", "secondary"], (
        f"the model now carries {undeclared}; if the card sends the verb and the auth flag, this row "
        f"is the one that has to be rewritten into an assertion about what it sends")


@pytest.mark.parametrize("name", sorted(SHAPES))
def test_every_shape_the_builder_makes_is_accepted_by_the_block(name: str):
    _assert_accepted(f"the {name} card", _actions(name))


@pytest.mark.parametrize("locale", ["zh-HK", "zh-CN", "en"])
def test_the_verbs_are_the_registrys_not_the_event_names(locale: str):
    # AGENT_CONTRACT §10 is the EVENT registry; `view` and `cart_add` belong to it, not to a card.
    for name in SHAPES:
        for a in _actions(name, locale):
            assert a["type"] not in {"view", "cart_add", "ask"}, (
                f"the {name} card sends the event-registry word {a['type']!r} as a CTA kind")


def test_the_browse_cta_of_an_offering_card_names_its_merchant_not_itself():
    actions = _actions("bookable offering")
    browse = actions[0]
    assert browse["type"] == "view_menu"
    assert browse["endpoint"] == f"/api/v1/merchants/{MERCHANT}", (
        f"the card printed {browse['endpoint']} - an offering slug in a merchant path, which "
        f"`GET /api/v1/merchants/{{idOrSlug}}` answers with `merchant_not_found`")
    assert not browse["endpoint"].endswith(OFFERING)
    assert _actions("merchant")[0]["endpoint"] == f"/api/v1/merchants/{MERCHANT}"


def test_the_compare_action_sends_the_null_the_block_names_it_for():
    for name in SHAPES:
        compare = [a for a in _actions(name) if a["type"] == "compare"]
        assert len(compare) == 1, f"the {name} card sent {len(compare)} compare actions"
        assert "endpoint" in compare[0], "`required` asks for the key to be PRESENT"
        assert compare[0]["endpoint"] is None, (
            "the block's own description calls `compare` the client-side-only action and the "
            "fixture sends null for it; an `/ai/v1/...` path is both the wrong door and a "
            "pattern offence")


def test_the_agent_cta_opens_a_platform_thread_and_not_the_ai_lanes_door():
    actions = _actions("merchant with an agent")
    message = [a for a in actions if a["type"] == "message"]
    assert len(message) == 1, f"an agent-enabled card sent {len(message)} message actions"
    assert message[0]["endpoint"] == "/api/v1/conversations"
    assert message[0]["payload"] == {"merchant_id": str(SUBJ)}, (
        "the platform defaults channel and mode (`ConversationService.java:78-79`), so naming the "
        "merchant is the whole body")
    for a in actions:
        assert not str(a.get("endpoint") or "").startswith("/ai/v1/"), (
            f"the card points a client at the AI lane's own door {a['endpoint']}")


def test_no_card_prints_two_buttons_reading_the_same_word():
    for name in SHAPES:
        for locale in ("zh-HK", "zh-CN", "en"):
            labels = [a["label"] for a in _actions(name, locale)]
            assert len(labels) == len(set(labels)), (
                f"the {name} card at {locale} prints {labels}; two CTAs with the same word give "
                f"the reader no way to tell them apart")


def test_every_card_the_demo_plane_serves_is_accepted_by_the_block():
    cards = _cards_from("")
    assert cards, "the plane served no card, so this row measured nothing"
    for card in cards:
        _assert_accepted(f"demo card {card['slug']}", card.get("actions") or [])


@live_only
def test_every_card_the_live_plane_serves_is_accepted_by_the_block():
    cards = _cards_from(DB_URL)
    assert cards, "the live plane served no card, so this row measured nothing"
    for card in cards:
        _assert_accepted(f"live card {card['slug']}", card.get("actions") or [])


@live_only
def test_no_live_card_prints_its_own_slug_where_a_merchants_slug_belong():
    cards = _cards_from(DB_URL)
    wrong = []
    for card in cards:
        if card.get("card_type") == "merchant":
            continue
        for a in (card.get("actions") or []):
            endpoint = str(a.get("endpoint") or "")
            if endpoint.startswith("/api/v1/merchants/") and endpoint.rsplit("/", 1)[-1] == card["slug"]:
                wrong.append(f"{card['slug']} -> {endpoint}")
    assert not wrong, (
        "these offering cards put the offering's own slug in a merchant path, and "
        "`CatalogController.java:484` answers that with `merchant_not_found`: " + ", ".join(wrong))
