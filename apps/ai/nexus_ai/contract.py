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

from pydantic import BaseModel, ConfigDict, Field

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


class UnderstandRequest(_Strict):
    query: str
    context: dict[str, Any] = Field(default_factory=dict)


class UnderstandResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")
    intent: Intent
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
