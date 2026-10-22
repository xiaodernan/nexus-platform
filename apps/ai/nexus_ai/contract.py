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

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    model_config = ConfigDict(extra="ignore")
    status: Optional[str] = None
    next_slot: Optional[datetime] = None
    source_fact_id: Optional[UUID] = None


class CardAction(_Strict):
    type: str
    label: str
    endpoint: str
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
    ai_match: Optional[AiMatch] = None
    actions: list[CardAction] = Field(default_factory=list)
    facts: list[Fact] = Field(default_factory=list)
    flags: EntityFlags = Field(default_factory=EntityFlags)
    # ranking internals, never rendered by the UI but needed by /compare + eval
    organic_rank: Optional[int] = None
    score_breakdown: dict[str, float] = Field(default_factory=dict)


class IntentLocation(_Strict):
    type: Optional[Literal["district", "address", "area", "nearby", "city", "landmark"]] = None
    value: Optional[str] = None
    resolved: Optional[GeoPoint] = None
    radius_m: Optional[int] = None


class IntentTime(_Strict):
    type: Optional[Literal["explicit", "relative", "range", "unspecified"]] = None
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
    location: IntentLocation = Field(default_factory=IntentLocation)
    time: IntentTime = Field(default_factory=IntentTime)
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
