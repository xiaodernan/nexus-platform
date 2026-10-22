"""The registry's tool names — one list, read by everyone who needs it.

AGENT_CONTRACT §3 names the canonical set: *implement exactly these, add to the registry,
never bypass*. Two readers need that list — the manifest at `GET /ai/v1/tools` and the
trust layer's tool-name scanner — and D496 found the two readers holding hand-written
copies that differed: the scanner's copy was missing eight of the twenty-four names, so a
merchant document that named `summarize_reviews` (or `analyze_reviews`,
`compare_entities`, `get_business_hours`, `search_location`, `search_reviews`,
`search_services`, `get_user_preferences`) was **not** flagged at all.

The list is here, and the readers take it from here.
"""

from __future__ import annotations

#: AGENT_CONTRACT §3's canonical tool names — implement exactly these, never bypass.
CANONICAL_TOOL_NAMES: tuple[str, ...] = (
    "search_merchants", "search_products", "search_services", "search_reviews",
    "search_location", "get_business_hours", "get_price", "get_inventory",
    "get_availability", "create_reservation", "create_cart", "update_cart",
    "checkout", "get_order_status", "search_web", "retrieve_merchant_documents",
    "analyze_reviews", "get_user_preferences", "set_user_preference",
    "summarize_reviews", "compare_entities", "draft_campaign", "draft_seo_page",
    "record_event",
)

#: The two tools AGENT_CONTRACT §4 names as **never** in a default grant. They are not in
#: the canonical set, but content that names a tool is content that names a tool — and a
#: scanner that misses a name is a scanner that misses an injection.
NEVER_IN_DEFAULT_GRANT: tuple[str, ...] = ("refund_payment", "publish_campaign")
