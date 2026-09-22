package com.nexus.growth;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.ApiException;
import com.nexus.platform.IdempotencyService;
import com.nexus.platform.Idempotent;
import com.nexus.platform.Json;
import com.nexus.platform.Principal;
import com.nexus.platform.Req;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code POST /api/v1/events} — the telemetry batch the SDK flushes into (API_CONTRACT §11, §58,
 * AGENT_CONTRACT §10). Honest limits, restated in code:
 *
 * <ul>
 *   <li><b>Append-only.</b> The handler reaches the table through {@link EventRepository} and
 *       nothing else: there is no update or delete path on this endpoint.</li>
 *   <li><b>Idempotent per batch.</b> {@code Idempotency-Key} is required and de-dupes a flushed
 *       batch (replay returns the recorded response); individual events are additionally de-duped
 *       by {@code event_id}, so retries can never double-count.</li>
 *   <li><b>Unauthenticated callers are anonymous.</b> Every event must carry a
 *       {@code session_id}; an anonymous caller may not attribute an event to a user id — the
 *       actor is forced to {@code anonymous}.</li>
 *   <li><b>Attribution is server-computed.</b> A signed-in caller's {@code actor_type}/{@code
 *       actor_id} are overwritten from the principal, and {@code tenant_id} is always the
 *       resolved tenant — a client can neither forge attribution nor cross tenants.</li>
 *   <li><b>An event is an observation.</b> No business invariant is validated against it, it is
 *       never a write path for anything a user sees, and per §66 nothing collected here may feed
 *       organic ranking.</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/v1")
public class EventsController {

    /** A batch bigger than this is refused outright rather than half-ingested (§11's honest limit). */
    static final int MAX_BATCH = 50;
    private static final int MAX_JSON_BYTES = 16 * 1024;
    private static final long MAX_FUTURE_SKEW_MINUTES = 10;
    private static final Pattern EVENT_NAME = Pattern.compile("^[a-z][a-z0-9_]{0,63}$");
    private static final Pattern SUBJECT_TYPE = Pattern.compile("^[a-z][a-z0-9_]{0,31}$");
    private static final Pattern SESSION_ID = Pattern.compile("^[A-Za-z0-9_-]{8,64}$");
    private static final Set<String> DECLARED_ACTOR_TYPES =
            Set.of("user", "merchant_user", "agent", "system", "anonymous");
    /** Cap on per-batch rejection detail — the counts stay exact, only the listing is bounded. */
    private static final int MAX_REJECTION_DETAILS = 10;

    private final EventRepository events;
    private final IdempotencyService idempotency;

    public EventsController(EventRepository events, IdempotencyService idempotency) {
        this.events = events;
        this.idempotency = idempotency;
    }

    @PostMapping("/events")
    @ResponseStatus(HttpStatus.ACCEPTED)
    @Idempotent(scope = "events")
    public Map<String, Object> ingest(@RequestBody(required = false) JsonNode body, HttpServletRequest request) {
        if (body == null || !body.isObject() || !body.path("events").isArray()) {
            throw ApiException.validation("Body must be {events: [...]} — an array of event objects",
                    Json.map("field", "events"));
        }
        List<JsonNode> batch = new ArrayList<>();
        body.path("events").forEach(batch::add);
        if (batch.size() > MAX_BATCH) {
            throw ApiException.validation("Batch exceeds the maximum of " + MAX_BATCH + " events — split it",
                    Json.map("max_batch", MAX_BATCH, "received", batch.size()));
        }
        String key = request.getHeader("Idempotency-Key");
        Principal principal = Req.principalOrNull(request);
        // A replayed batch must not re-execute; the recorded {accepted, rejected} is returned as-is.
        return idempotency.run("events", key, principal == null ? null : principal.subjectId(),
                () -> append(batch, request, principal));
    }

    private Map<String, Object> append(List<JsonNode> batch, HttpServletRequest request, Principal principal) {
        TenantContext tenant = Req.tenant(request);
        int accepted = 0;
        int duplicates = 0;
        int rejected = 0;
        List<Map<String, Object>> rejectReasons = new ArrayList<>();

        for (int i = 0; i < batch.size(); i++) {
            EventRepository.EventRow row;
            try {
                row = validate(batch.get(i), i, request, principal);
            } catch (RejectedEventException e) {
                rejected++;
                if (rejectReasons.size() < MAX_REJECTION_DETAILS) {
                    rejectReasons.add(Json.map("index", e.index(), "reason", e.reason()));
                }
                continue;
            }
            if (events.append(tenant, row)) {
                accepted++;
            } else {
                // event_id already in the table — the observation is durable, just not doubled.
                duplicates++;
            }
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("accepted", accepted + duplicates);
        out.put("rejected", rejected);
        out.put("duplicates", duplicates);
        out.put("reject_reasons", rejectReasons);
        out.put("max_batch", MAX_BATCH);
        out.put("note", "Events are append-only observations (§58). They are never an input to organic "
                + "ranking (§66) and never a write path for user-visible records (§11).");
        return out;
    }

    /** Internal control flow only: an event that fails shape validation, with its batch index. */
    private static final class RejectedEventException extends RuntimeException {
        private final int index;
        private final String reason;

        private RejectedEventException(int index, String reason) {
            super(reason);
            this.index = index;
            this.reason = reason;
        }

        private int index() {
            return index;
        }

        private String reason() {
            return reason;
        }
    }

    private EventRepository.EventRow validate(JsonNode e, int index, HttpServletRequest request,
                                              Principal principal) {
        if (!e.isObject()) {
            throw new RejectedEventException(index, "not_an_object");
        }
        UUID eventId = readUuid(e, "event_id", index);
        if (eventId == null) {
            eventId = UUID.randomUUID();
        }
        String name = e.path("name").isTextual() ? e.path("name").asText().trim() : null;
        if (name == null || !EVENT_NAME.matcher(name).matches()) {
            throw new RejectedEventException(index, "name_invalid");
        }

        Instant occurredAt;
        if (e.hasNonNull("occurred_at")) {
            try {
                occurredAt = OffsetDateTime.parse(e.get("occurred_at").asText()).toInstant();
            } catch (RuntimeException ex) {
                throw new RejectedEventException(index, "occurred_at_invalid");
            }
        } else {
            occurredAt = Instant.now();
        }
        if (occurredAt.isAfter(Instant.now().plus(MAX_FUTURE_SKEW_MINUTES, ChronoUnit.MINUTES))) {
            throw new RejectedEventException(index, "occurred_at_in_future");
        }

        String declaredActor = e.hasNonNull("actor_type") ? e.get("actor_type").asText() : null;
        if (declaredActor != null && !DECLARED_ACTOR_TYPES.contains(declaredActor)) {
            throw new RejectedEventException(index, "actor_type_invalid");
        }
        String actorType;
        UUID actorId;
        String sessionId = textOrNull(e, "session_id");
        if (principal == null) {
            // §11: unauthenticated ingest is allowed only as an anonymous event carrying a session id.
            if (declaredActor != null && !"anonymous".equals(declaredActor)) {
                throw new RejectedEventException(index, "anonymous_caller_must_not_claim_actor");
            }
            String sid = firstNonNull(sessionId, validHeaderSession(request));
            if (sid == null) {
                throw new RejectedEventException(index, "anonymous_event_requires_session_id");
            }
            actorType = "anonymous";
            actorId = null;
            sessionId = sid;
        } else {
            // Attribution is a server fact, never a client claim (§48-52 subject model).
            actorType = principal.subjectType();
            actorId = principal.subjectId();
        }

        String subjectType = textOrNull(e, "subject_type");
        if (subjectType != null && !SUBJECT_TYPE.matcher(subjectType).matches()) {
            throw new RejectedEventException(index, "subject_type_invalid");
        }
        UUID subjectId = readUuid(e, "subject_id", index);
        UUID conversationId = readUuid(e, "conversation_id", index);
        if ((subjectId == null) != (subjectType == null)) {
            throw new RejectedEventException(index, "subject_type_and_id_must_pair");
        }
        String propertiesJson = jsonField(e, "properties", index);
        String contextJson = jsonField(e, "context", index);
        if ((propertiesJson + contextJson).getBytes(java.nio.charset.StandardCharsets.UTF_8).length > MAX_JSON_BYTES) {
            throw new RejectedEventException(index, "payload_too_large");
        }
        return new EventRepository.EventRow(eventId, actorType, actorId, name, subjectType, subjectId,
                sessionId, conversationId, propertiesJson, contextJson, Timestamp.from(occurredAt));
    }

    private static UUID readUuid(JsonNode e, String field, int index) {
        if (!e.hasNonNull(field)) {
            return null;
        }
        UUID parsed = Json.uuidOrNull(e.get(field).asText());
        if (parsed == null) {
            throw new RejectedEventException(index, field + "_must_be_uuid");
        }
        return parsed;
    }

    /** properties/context are structured json objects; free text is stored nowhere (§11). */
    private static String jsonField(JsonNode e, String field, int index) {
        if (!e.hasNonNull(field)) {
            return "{}";
        }
        JsonNode v = e.get(field);
        if (!v.isObject()) {
            throw new RejectedEventException(index, field + "_must_be_object");
        }
        return v.toString();
    }

    private static String textOrNull(JsonNode e, String field) {
        return e.hasNonNull(field) && e.get(field).isTextual() ? e.get(field).asText().trim() : null;
    }

    private static String validHeaderSession(HttpServletRequest request) {
        String header = request.getHeader("X-Session-Id");
        return header != null && SESSION_ID.matcher(header).matches() ? header : null;
    }

    private static String firstNonNull(String a, String b) {
        return a != null && !a.isBlank() ? a : b;
    }
}
