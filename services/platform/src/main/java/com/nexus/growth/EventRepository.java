package com.nexus.growth;

import com.nexus.platform.Json;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.sql.Timestamp;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Append-only writer for the {@code events} table (§58, API_CONTRACT §11).
 *
 * <p>There is deliberately no update or delete method here: telemetry is an observation, not a
 * record a user can see, and §11 pins the ingest to append-only. Retried batches are made safe by
 * {@code on conflict (event_id) do nothing} — {@code event_id} is the dedupe key of
 * AGENT_CONTRACT §10, so the same event can never be double-counted even if two different batch
 * keys carry it.
 */
@Repository
public class EventRepository {

    private final TenantJdbc jdbc;

    public EventRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Appends one validated event. Returns {@code true} when the row was newly written,
     * {@code false} when the {@code event_id} was already present (client retry / overlapping batch).
     */
    public boolean append(TenantContext tenant, EventRow e) {
        int inserted = jdbc.updateForTenant(tenant, """
                insert into events (event_id, tenant_id, actor_type, actor_id, name, subject_type, subject_id,
                                    session_id, conversation_id, properties, context, occurred_at)
                values (cast(:event_id as uuid), :tenant_id, :actor_type, cast(:actor_id as uuid), :name,
                        :subject_type, cast(:subject_id as uuid), :session_id, cast(:conversation_id as uuid),
                        cast(:properties as jsonb), cast(:context as jsonb), cast(:occurred_at as timestamptz))
                on conflict (event_id) do nothing
                """, Json.map("event_id", e.eventId(), "actor_type", e.actorType(), "actor_id", e.actorId(),
                "name", e.name(), "subject_type", e.subjectType(), "subject_id", e.subjectId(),
                "session_id", e.sessionId(), "conversation_id", e.conversationId(),
                "properties", e.propertiesJson(), "context", e.contextJson(), "occurred_at", e.occurredAt()));
        return inserted > 0;
    }

    /** A fully validated row: every field was checked by the controller, so nothing here re-parses. */
    public record EventRow(UUID eventId, String actorType, UUID actorId, String name, String subjectType,
                           UUID subjectId, String sessionId, UUID conversationId, String propertiesJson,
                           String contextJson, Timestamp occurredAt) {
    }
}
