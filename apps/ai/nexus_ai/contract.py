"""Shared contract objects — API_CONTRACT.md §2 and §7.1, AGENT_CONTRACT.md §10.

Field names are snake_case exactly as the contract spells them; these models ARE the
HTTP shapes, so the frontend / platform service can code off them. `extra="forbid"`
where the contract fixes a shape, so drift fails loudly instead of silently.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_serializer

IntentKind = Literal[
    "discover_merchant",
    "discover_offering",
    "reserve",
    "purchase",
    "ask_merchant",
    "compare",
    "plan_experience",
    "unknown",
]
SortPreference = Literal["relevance", "distance", "price_low", "rating", "trending"]
FactSource = Literal["merchant", "imported", "observed", "third_party", "inferred", "demo"]
ActorType = Literal["user", "merchant_user", "agent", "system", "anonymous"]
#: D408: the card kinds, named once. The `EntityCard.card_type` field carried the
#: Literal inline, so the card builder could only spell it as a plain `str` and the
#: checker could not see the vocabulary it was filling.
CardType = Literal["merchant", "product", "service", "experience", "collection"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class GeoPoint(_Strict):
    lat: float
    lng: float


class Money(_Strict):
    amount: str
    currency: str = "HKD"
    model: Optional[str] = None

    @classmethod
    def of(cls, value: Decimal | float | str | None, currency: str = "HKD",
           model: str | None = None) -> Optional["Money"]:
        if value is None:
            return None
        dec = Decimal(str(value)).quantize(Decimal("0.01"))
        return cls(amount=f"{dec:.2f}", currency=currency, model=model)


class Fact(_Strict):
    """§19 trust primitive: any AI-stated fact cites one of these."""

    fact_id: UUID
    subject_type: str
    subject_id: UUID
    attribute: str
    value: Any
    source: FactSource
    confidence: float
    observed_at: datetime
    expires_at: Optional[datetime] = None
    stale: bool = False

    @property
    def confidence_hint(self) -> str | None:
        """§4: <0.6 phrase as uncertain, <0.4 omit and offer handoff. Never upgrade."""
        if self.confidence < 0.4:
            return "omit_and_offer_handoff"
        if self.confidence < 0.6:
            return "phrase_as_uncertain"
        return None

    @property
    def effective_stale(self) -> bool:
        if self.stale:
            return True
        return bool(self.expires_at and self.expires_at <= datetime.now(self.expires_at.tzinfo))


class MatchExplanation(_Strict):
    """§18 — every bullet must trace to a fact id; the UI must drop a bullet with no fact_id."""

    label: str
    text: str
    value: Optional[str] = None
    fact_id: Optional[UUID] = None


class OpenState(BaseModel):
    model_config = ConfigDict(extra="ignore")
    is_open: Optional[bool] = None
    text: Optional[str] = None
    opens_at: Optional[datetime] = None
    closes_at: Optional[datetime] = None
    as_of: Optional[datetime] = None
    source_fact_id: Optional[UUID] = None


class AvailabilityBrief(BaseModel):
    # the key names are `fact.json#/$defs/AvailabilityInfo`'s, which forbids anything else:
    # the citation is `fact_id` there, not `OpenState`'s `source_fact_id`.
    model_config = ConfigDict(extra="ignore")
    status: Optional[str] = None
    next_slot: Optional[datetime] = None
    as_of: Optional[datetime] = None
    fact_id: Optional[UUID] = None


class CardAction(_Strict):
    type: str
    label: str
    # D642: `endpoint` is required but NULLABLE on the wire - `$defs/CardAction` types it
    # ["string","null"] and its description says "Null for client-side-only actions such as
    # `compare`", which is what `packages/types/fixtures/entity_card.json:47` sends. Declared `str`
    # here, the model could not express the one action the block names as client-side, so the builder
    # filled it with an `/ai/v1/...` path the same block's pattern rejects. The key stays present
    # (`pipeline.py:214` dumps without `exclude_none`), which is what `required` asks for.
    endpoint: Optional[str] = None
    payload: dict[str, Any] = Field(default_factory=dict)


class EntityImage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    url: Optional[str] = None
    alt: Optional[str] = "demo image"
    credit: Optional[str] = "synthetic"


class EntityFlags(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sponsored: bool = False
    demo: bool = False
    unverified: bool = False
    # D472: API_CONTRACT §2 names this flag - "estimated_price on offering cards
    # (offerings.price_source = 'estimated')" - and the offering's query already selects
    # `price_source`, but the flag could never be sent, so a renderer told to look for it
    # was looking for a field that was never there.
    estimated_price: bool = False
    # D498: API_CONTRACT §2 names this flag - "verified_visit on review cards (the
    # reviewer transacted)". The review card is not yet implemented in the AI lane (the
    # platform owns reviews), but the flag is part of the shared contract and must be
    # present on the model. The value is derived from `reviews.verified_purchase` OR
    # `reviews.verified_reservation` (the reviewer transacted).
    verified_visit: bool = False
    # D497: AGENT_CONTRACT §4 says "Conflicts create a `trust_signals` row rather than
    # silently picking" - and the product picked silently: the card showed one value and
    # the other one vanished. The ROW is the platform's to write (the AI role has no grant
    # on `trust_signals` - filed), so the card says the value is disputed instead. The
    # contract's §2 should name this flag (filed: a new flag name belongs in §2).
    conflicting_fact: bool = False


class AiMatch(BaseModel):
    model_config = ConfigDict(extra="ignore")
    score: float
    reasons: list[MatchExplanation] = Field(default_factory=list)


#: D674: the two card types the published closed object leaves `duration_minutes` legal on.
#: `packages/types/src/schemas/entity_card.json` publishes the key at its base (`:98`,
#: `{"type": ["integer", "null"], "minimum": 0}`) and then names it `false` - the key must not appear
#: at all - under `merchant` (`:117`), `product` (`:135`) and `collection` (`:196`), while
#: `service`/`experience` (`:151`/`:164` of `card.ts`) declare it as their own field. "Absent" is not
#: something `Optional[int] = None` can express in a `model_dump`, so the rule lives on the model
#: rather than at each of the lane's two dump sites (`api/pipeline.py:214` and the nested card list of
#: `api/stream.py:116`); a gate reads the five `allOf` blocks back out of the schema file, so widening
#: the contract shows up there before it can show up here unnoticed.
DURATION_CARD_TYPES = frozenset({"service", "experience"})


class EntityCard(BaseModel):
    """§2 the single render contract for consumer + AI + MCP surfaces."""

    model_config = ConfigDict(extra="ignore")
    card_type: CardType = "merchant"
    id: UUID
    slug: str
    title: str
    subtitle: Optional[str] = None
    image: Optional[EntityImage] = None
    price: Optional[Money] = None
    rating: Optional[dict[str, Any]] = None
    distance: Optional[dict[str, Any]] = None
    open: Optional[OpenState] = None
    availability: Optional[AvailabilityBrief] = None
    # D674: how long the offering takes, in the offering's own words. A service/experience card that
    # prints a `reserve` CTA states the length the booking needs; on a card type that forbids the key
    # this never reaches the wire, whatever the row carried.
    duration_minutes: Optional[int] = None
    ai_match: Optional[AiMatch] = None
    actions: list[CardAction] = Field(default_factory=list)
    facts: list[Fact] = Field(default_factory=list)
    flags: EntityFlags = Field(default_factory=EntityFlags)
    # D667: no ranking internal sits here. The published card
    # (`packages/types/src/schemas/entity_card.json`) is a closed object of 43 properties and names
    # neither `organic_rank` nor the eight-component `score_breakdown`, so every card the lane
    # answered was two closed-object offences - 19 of 19 demo and 54 of 54 live payloads. The comment
    # this replaces claimed "/compare + eval" needed them: the compare route answers `CompareRow`
    # attribute cells and never reads a card dict, and 0 lines in `apps/web`, `packages/ui` or
    # `packages/types` name either key. Neither is a debug rung either - `debug|explain|verbose`
    # occurs zero times across API_CONTRACT and AGENT_CONTRACT - and these dicts are serialized
    # verbatim into the summary call to a model provider, so the paid/organic position and this
    # user's component scores left the lane twice per answer. The ranking keeps both where it reads
    # them: `Scored.breakdown` and `Candidate.raw["organic_rank"]` (`search/ranking.py`).

    @model_serializer(mode="wrap")
    def _closed_object_shape(self, handler: Any) -> dict[str, Any]:
        """Drop the keys this card's own type refuses, so a null never stands in for an absent field."""
        data = handler(self)
        if self.card_type not in DURATION_CARD_TYPES:
            data.pop("duration_minutes", None)
        return data


class IntentLocation(_Strict):
    type: Optional[Literal["district", "address", "area", "nearby", "city", "landmark"]] = None
    value: Optional[str] = None
    resolved: Optional[GeoPoint] = None
    radius_m: Optional[int] = None


class IntentTime(_Strict):
    # D725: `open_now` is the member `packages/types/src/schemas/intent.json` publishes for
    # this field and this model did not, so the frame the schema's own fixture ships was
    # refused inbound (`tmp/d711_published_domain.txt`).
    type: Optional[Literal["explicit", "relative", "range", "open_now", "unspecified"]] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    raw: Optional[str] = None
    # e.g. "open_late_after" — a qualitative time preference with no resolvable date
    quality: Optional[str] = None


class IntentBudget(_Strict):
    min: Optional[float] = None
    max: Optional[float] = None
    currency: str = "HKD"
    per: Optional[Literal["party", "person", "item"]] = None


class PreferenceItem(_Strict):
    key: str
    value: str
    polarity: int = 1


class ConstraintItem(_Strict):
    key: str
    value: str


class Intent(_Strict):
    """§7.1 canonical query-understanding object. Never guess: absent ⇒ null + `unknowns`."""

    raw_query: str
    intent: IntentKind = "unknown"
    category: Optional[str] = None
    # D710: the contract publishes each ref as `oneOf [ref, null]` and null is its word for
    # 「the user said nothing」 (`packages/types/src/schemas/intent.json`: "Null means the user
    # said nothing about place — the agent asks (spec §8) instead of using the tenant's default
    # district"). A `default_factory` sent an object of nulls - neither branch, since `LocationRef`
    # requires a `type` and `LocationRefType` has no null - so the published validator refused 14
    # of 14 turns in `tmp/d687_hollow_measure.txt` (27 issues on these two paths); the shape that
    # publish permits inbound was refused here (422 at `["body","intent","location"]`); and
    # `bool()` of the hollow object is what `search/service.py:984` reads to set `strip_time`, so
    # every live turn removed its time vocabulary although `nlu/understand.py:964` allows that only
    # "when the time lane PARSED a time" - 「邊度有午市自助餐」 searched as 「自助餐」, 16 of 20 live
    # rows apart. Absent is what both directions and that reader ask for.
    location: Optional[IntentLocation] = None
    time: Optional[IntentTime] = None
    budget: Optional[IntentBudget] = None
    party_size: Optional[int] = None
    preferences: list[PreferenceItem] = Field(default_factory=list)
    constraints: list[ConstraintItem] = Field(default_factory=list)
    sort_preference: SortPreference = "relevance"
    urgency: Literal["now", "normal", "flexible"] = "normal"
    language: str = "zh-HK"
    confidence: dict[str, float] = Field(default_factory=dict)
    unknowns: list[str] = Field(default_factory=list)
    # entities the user named explicitly (compare / ask_merchant paths)
    mentioned_entities: list[str] = Field(default_factory=list)
    # resolved merchant id(s) when the surface already knows them
    merchant_id: Optional[UUID] = None
    # §7.1 / §34: the subjects the surface has already shown, which the next answer must not
    # repeat. The ALT cues write it (`state_merger.py`), `plan_from_intent` folds it into the
    # one filter key both reads already implement (`sql.py` `filters.exclude`), and it travels
    # back as `previous_intent` - the state is the only thing that survives a turn.
    excluded_ids: list[str] = Field(default_factory=list)

    @field_validator("location", "time", mode="before")
    @classmethod
    def _a_ref_that_says_nothing_is_absent(cls, value: Any) -> Any:
        """`{}` is what the writers send for 「nothing was said」; the published shape says null.

        Read the empty mapping as absent so the model answers the same question as the
        extractor's plain dict (`understand.py:380`, `state_merger.py:222`), and leave a ref
        with any member set alone: a place named without a type is still that place.
        """
        if isinstance(value, dict) and not any(value.values()):
            return None
        return value


class SearchRequestFilters(_Strict):
    district: Optional[str] = None
    category: Optional[str] = None
    max_price: Optional[float] = None
    min_price: Optional[float] = None
    open_now: Optional[bool] = None
    min_rating: Optional[float] = None
    tags: list[str] = Field(default_factory=list)
    attributes: dict[str, Any] = Field(default_factory=dict)
    avoid: list[str] = Field(default_factory=list)
    kind: Optional[Literal["merchant", "product", "service", "experience"]] = None
    merchant_id: Optional[UUID] = None


#: The longest query the service accepts - the same cap the BFF enforces before it
#: pays for a model call (D410).
MAX_QUERY_LENGTH = 200


class CompareRequest(_Strict):
    """The comparison's request (API_CONTRACT §7: `{subject_ids:[...], geo?:{lat,lng}}`).

    D401: a distance needs a reference point. The grid grew a `distance` row
    (S37's comparison is price / rating / distance, and the e2e spec asserts the
    table shows all three), so the caller passes the point it is comparing FROM.
    Without it the row is simply absent - the grid never invents a distance.
    """

    subject_ids: list[UUID] = Field(min_length=2, max_length=5)
    tenant_id: Optional[UUID] = None
    locale: str = "zh-HK"
    geo: Optional[GeoPoint] = None


class StreamSearchRequest(_Strict):
    """Body shape the web BFF forwards verbatim
    (`apps/web/app/api/nexus/ai/stream/route.ts`)."""

    query: str
    conversation_id: Optional[UUID] = None
    previous_intent: Optional[dict[str, Any]] = None
    context: dict[str, Any] = Field(default_factory=dict)
    limit: int = 8

    @field_validator("query")
    @classmethod
    def _check_query(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("query is required")
        if len(v) > MAX_QUERY_LENGTH:
            raise ValueError(f"query must be at most {MAX_QUERY_LENGTH} characters")
        return v


class ImportExtractRequest(_Strict):
    """The import door's request (API_CONTRACT §7.0 - service to service)."""

    source_type: str
    source_ref: str | None = None
    raw_text: str


class HandbookAskSection(_Strict):
    """One manual section, exactly as the retrieval lane believes relevant (API_CONTRACT §7)."""

    id: str = Field(min_length=1, max_length=48)
    kicker: str = Field(default="", max_length=80)
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=2400)


class HandbookAskRequest(_Strict):
    """The manual-phrase lane's request — question + the top sections; the model owns nothing else."""

    question: str = Field(min_length=1, max_length=400)
    sections: list[HandbookAskSection] = Field(min_length=1, max_length=8)
    locale: str = Field(default="zh-HK", max_length=16)


class ChapterAskSection(_Strict):
    """One excerpt of ONE chapter, exactly as the reader's lane believes relevant."""

    id: str = Field(min_length=1, max_length=48)
    kicker: str = Field(default="", max_length=80)
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=1600)


class ChapterAskRequest(_Strict):
    """The chapter-companion lane's request — one chapter, the top excerpts; the model owns nothing else."""

    question: str = Field(min_length=1, max_length=400)
    chapter_id: str = Field(min_length=1, max_length=120)
    chapter_title: str = Field(min_length=1, max_length=200)
    sections: list[ChapterAskSection] = Field(min_length=1, max_length=8)
    locale: str = Field(default="zh-HK", max_length=16)
    atlas_context: str = Field(default="", max_length=1200)


class AhWanTurn(_Strict):
    """One turn of the in-world Ah Wan dialogue — role user or ah-wan (assistant)."""

    role: str = Field(min_length=1, max_length=16)
    content: str = Field(min_length=1, max_length=400)


class AhWanDialogueRequest(_Strict):
    """The NPC Ah Wan's request — locale, latest line; history stays client-side."""

    locale: str = Field(default="zh-HK", max_length=16)
    message: str = Field(min_length=1, max_length=220)
    history: list[AhWanTurn] = Field(default_factory=list, max_length=12)


class WorldGuideCandidate(_Strict):
    """One place the traveler could go next — curated by the web lane, never invented by the model."""

    slug: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=200)
    blurb: str = Field(default="", max_length=240)


class WorldGuideRequest(_Strict):
    """The world-guide lane's request — where the reader stands and how much time they have,
    the web lane's curated candidates in; ONE next step + its phrasing out."""

    locale: str = Field(default="zh-HK", max_length=16)
    surface: str = Field(default="guides", max_length=24)
    current_title: str = Field(default="", max_length=200)
    minutes: int = Field(default=30, ge=1, le=1440)
    candidates: list[WorldGuideCandidate] = Field(min_length=1, max_length=6)


class AdminEventsSnapshot(_Strict):
    """The /admin/system reader's REAL numbers, verbatim — the model sees no store, no tenant, no identity."""

    xlen: int | None = Field(default=None, ge=0, le=10_000_000)
    pending: int | None = Field(default=None, ge=0, le=10_000_000)
    consumers: int | None = Field(default=None, ge=0, le=10_000)
    disabled: bool = False
    degraded: bool = False
    recent_count: int = Field(default=0, ge=0, le=1000)
    top_templates: list[str] = Field(default_factory=list, max_length=4)


class AdminDigestRequest(_Strict):
    """The operator's digest lane — aggregated counters in, grounded read + ≤3 actions out."""

    events: AdminEventsSnapshot
    locale: str = Field(default="zh-HK", max_length=16)


class InsightsWeekPoint(_Strict):
    date: str = Field(min_length=10, max_length=10)
    label: str = Field(default="", max_length=40)
    total: int = Field(ge=0, le=100_000)
    dropRate: int = Field(ge=0, le=100)
    topProfile: str = Field(default="", max_length=32)


class InsightsWeek(_Strict):
    weeklyTotal: int = Field(ge=0, le=1_000_000)
    slope: float
    adviceKind: str = Field(default="flat", max_length=20)
    points: list[InsightsWeekPoint] = Field(default_factory=list, max_length=14)


class InsightsStats(_Strict):
    """The seeded ghost-replay snapshot — the exact shape the web's simulator produces."""

    date: str = Field(min_length=1, max_length=40)
    total: int = Field(ge=0, le=100_000)
    hourRamp: list[int] = Field(min_length=24, max_length=24)
    headline: str = Field(default="", max_length=400)
    recommendation: str = Field(default="", max_length=400)
    profiles: list[dict] = Field(min_length=0, max_length=12)
    week: InsightsWeek = Field(default_factory=lambda: InsightsWeek(weeklyTotal=0, slope=0.0, adviceKind='flat'))
    slope: float = 0.0


class InsightsNarrativeRequest(_Strict):
    """The operator's ghost-replay, stats only — the model sees no store, no session, no identity."""

    stats: InsightsStats
    locale: str = Field(default="zh-HK", max_length=16)


class SearchRequest(_Strict):
    intent: Optional[Intent] = None
    query: Optional[str] = None
    geo: Optional[GeoPoint] = None
    now: Optional[datetime] = None
    filters: SearchRequestFilters = Field(default_factory=SearchRequestFilters)
    limit: int = 20
    locale: str = "zh-HK"
    session_id: Optional[str] = None
    user_id: Optional[UUID] = None
    include_sponsored: bool = True


class FacetValue(BaseModel):
    model_config = ConfigDict(extra="ignore")
    value: str
    count: int


class SearchResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    items: list[EntityCard]
    facets: dict[str, list[FacetValue]] = Field(default_factory=dict)
    took_ms: int
    strategy: str
    degraded: bool = False
    provider: str = "mock"
    total_estimate: int = 0
    next_cursor: Optional[str] = None
    agent_run_id: Optional[UUID] = None
    relevance_floor_applied: bool = True
    # D467: the answer carries the intent it understood - the route used to patch this
    # field onto the dumped model, so the model did not describe the answer.
    intent: Optional[Intent] = None
    # D728: when a requested price band cannot be satisfied by the returned results,
    # the response states that plainly rather than showing out-of-band rows with no explanation.
    notice: Optional[str] = None


class ConversationView(BaseModel):
    """D469: the §52 audit view of one conversation - the contract names this shape.

    API_CONTRACT §7's row: "the §52 audit view of one conversation:
    `{conversation_id, agent_runs:[...], count, degraded, reason?}`".
    """

    model_config = ConfigDict(extra="ignore")
    conversation_id: str
    agent_runs: list[dict[str, Any]] = Field(default_factory=list)
    count: int = 0
    degraded: bool = True
    reason: Optional[str] = None


class DatabaseHealth(BaseModel):
    """D473: the health check's database block."""

    model_config = ConfigDict(extra="ignore")
    configured: bool = False
    available: bool = False
    error: Optional[str] = None


class EmbeddingsHealth(BaseModel):
    """D473: the health check's embeddings block."""

    model_config = ConfigDict(extra="ignore")
    provider: str = "hashing"
    dim: int = 1024


class HealthResponse(BaseModel):
    """D473: the health check's answer - a shape, not a dict written in a route."""

    model_config = ConfigDict(extra="ignore")
    status: str = "ok"
    service: str = "nexus-ai"
    version: str = "0.0.0"
    provider: str = "mock"
    offline: bool = False
    demo_data: bool = False
    database: DatabaseHealth = Field(default_factory=DatabaseHealth)
    embeddings: EmbeddingsHealth = Field(default_factory=EmbeddingsHealth)
    adapters: list[str] = Field(default_factory=list)
    now: str = ""


class ToolManifestEntry(BaseModel):
    """D473: one entry of the tool manifest - a name and what it may do."""

    model_config = ConfigDict(extra="ignore")
    name: str
    implemented: bool = False
    registry_status: str = "not_built"
    data_path_via_http: bool = False


class ToolsManifestResponse(BaseModel):
    """D473: the tool manifest's answer."""

    model_config = ConfigDict(extra="ignore")
    tools: list[ToolManifestEntry] = Field(default_factory=list)
    count: int = 0
    registry_status: str = "not_built"
    note: Optional[str] = None
    degraded: bool = True


class StreamStatusFrame(BaseModel):
    """D468: the SSE frames' payload shapes were hand-built dicts with no model."""

    model_config = ConfigDict(extra="ignore")
    stage: str
    text: str


class StreamResultsFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")
    set_id: str
    items: list[dict[str, Any]] = Field(default_factory=list)


class StreamSummaryFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")
    text: str
    citations: list[str] = Field(default_factory=list)


class StreamDoneFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")
    agent_run_id: str
    latency_ms: int
    cost_usd: float = 0.0
    degraded: bool = False
    provider: Optional[str] = None


class UnderstandRequest(_Strict):
    query: str
    context: dict[str, Any] = Field(default_factory=dict)


class UnderstandResponse(Intent):
    """D466: the answer IS the intent (API_CONTRACT §7's row: `{query, context}` -> `Intent`).

    The answer used to be a WRAPPER - `{intent: {...}, provider, degraded, follow_up_question}` -
    while five witnesses say the answer is the intent itself: the contract's row ("-> `Intent`
    (below)"), the contract's §7.1 shape, the cross-lane `Intent` interface
    (`packages/types/src/intent.ts`), the SDK's `queryUnderstand(): Promise<Intent>`, and the
    web lane's own mock of this endpoint. A client that followed the contract read
    `raw_query` and got `undefined`; one that read `intent` got an object where the contract
    says a kind.

    The service's three extras stay at the root: `provider` is already an optional field of
    the cross-lane `Intent` (and DECISIONS D4 requires the provider to be shown), `degraded`
    is the §105 degradation signal, and `follow_up_question` is §8's one follow-up question
    (D439). `degraded` and `follow_up_question` are not in the cross-lane type yet - filed.
    """

    provider: str = "mock"
    degraded: bool = False
    follow_up_question: Optional[str] = None


class CompareRow(BaseModel):
    model_config = ConfigDict(extra="ignore")
    attribute: str
    cards: list[dict[str, Any]] = Field(default_factory=list)


class RecommendRequest(_Strict):
    intent: Optional[Intent] = None
    conversation_id: Optional[UUID] = None
    query: Optional[str] = None
    geo: Optional[GeoPoint] = None
    now: Optional[datetime] = None
    limit: int = 8
    locale: str = "zh-HK"
    session_id: Optional[str] = None
    user_id: Optional[UUID] = None


class RecommendResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    set_id: UUID
    items: list[EntityCard]
    summary: Optional[str] = None
    citations: list[UUID] = Field(default_factory=list)
    provider: str = "mock"
    degraded: bool = False
    agent_run_id: Optional[UUID] = None
    latency_ms: int = 0
    cost_usd: float = 0.0


class RagRetrieveRequest(_Strict):
    query: str
    merchant_id: Optional[UUID] = None
    tenant_id: Optional[UUID] = None
    filters: dict[str, Any] = Field(default_factory=dict)
    top_k: int = 8


class RagChunk(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    text: str
    score: float
    document_id: UUID
    source_uri: Optional[str] = None
    fact_ids: list[UUID] = Field(default_factory=list)
    section: Optional[str] = None
    injection_signals: int = 0


class RagRetrieveResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    chunks: list[RagChunk]
    took_ms: int
    provider: str = "hashing"
    threshold_applied: bool = True
    # D467: the note the route used to patch onto the dumped model.
    note: Optional[str] = None


class CompareResponse(BaseModel):
    """D467: the comparison's answer had a shape no model declared."""

    model_config = ConfigDict(extra="ignore")
    rows: list[CompareRow] = Field(default_factory=list)
    subjects: list[UUID] = Field(default_factory=list)
    source: str = "static"
    degraded: bool = True


class FeedbackResponse(BaseModel):
    """D467: the feedback's answer had a shape no model declared."""

    model_config = ConfigDict(extra="ignore")
    recorded: bool = False
    degraded: bool = True
    reason: Optional[str] = None


class MerchantAgentRequest(_Strict):
    merchant_id: UUID
    message: str
    conversation_id: UUID
    context: dict[str, Any] = Field(default_factory=dict)


class FeedbackRequest(_Strict):
    subject_type: str
    subject_id: Optional[UUID] = None
    signal: str
    value: dict[str, Any] = Field(default_factory=dict)
    session_id: Optional[str] = None
    user_id: Optional[UUID] = None
    channel: str = "web"


# D449: the list of the canonical event names used to stand here, and nothing read it.
# AGENT_CONTRACT §10 is the one place those names live - a second copy here was a
# promise about a table this service writes one row of (`search`).


class Event(_Strict):
    name: str
    occurred_at: datetime
    tenant_id: Optional[str] = None
    actor_type: ActorType = "anonymous"
    actor_id: Optional[UUID] = None
    subject_type: Optional[str] = None
    subject_id: Optional[UUID] = None
    session_id: Optional[str] = None
    conversation_id: Optional[UUID] = None
    properties: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)
    event_id: Optional[UUID] = None


class ErrorBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    request_id: Optional[str] = None


class ErrorEnvelope(BaseModel):
    model_config = ConfigDict(extra="ignore")
    error: ErrorBody

class AgentPlanContext(_Strict):
    """Optional context for the agent-plan surface (API_CONTRACT §10)."""

    merchant_id: Optional[str] = None
    subject_id: Optional[str] = None
    subject_type: Optional[str] = None


class AgentPlanRequest(_Strict):
    """POST /ai/v1/agent/plan's body (§10: the minimum-step deterministic plan)."""

    query: str = Field(min_length=1, max_length=4000)
    context: Optional[AgentPlanContext] = None
    execute: bool = True
    subject: Optional[str] = Field(default=None, max_length=128)
