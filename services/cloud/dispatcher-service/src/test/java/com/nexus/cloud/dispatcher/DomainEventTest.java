package com.nexus.cloud.dispatcher;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class DomainEventTest {

    @Test
    void itReducesAStreamMessageToTheThreeFieldsTheDispatcherNeeds() {
        Map<String, String> stream = new LinkedHashMap<>();
        stream.put("template", "LeadCaptured");
        stream.put("type", "LeadCaptured");
        stream.put("tenant_id", "00000000-0000-0000-0000-000000000001");
        stream.put("payload", "{\"demo\":true}");
        DomainEvent event = DomainEvent.fromStreamBody("1700000000000-0", stream);

        assertThat(event.id()).isEqualTo("1700000000000-0");
        assertThat(event.type()).isEqualTo("LeadCaptured");
        assertThat(event.tenantId()).isEqualTo("00000000-0000-0000-0000-000000000001");
        // The body bytes begin with the canonical JSON object literal, not a single '{'.
        assertThat(new String(event.body(), java.nio.charset.StandardCharsets.UTF_8))
            .startsWith("{\"payload\":");
    }

    @Test
    void itSerialisesFieldsInKeyOrderForSignatureStability() {
        Map<String, String> stream = new LinkedHashMap<>();
        stream.put("z", "last");
        stream.put("a", "first");
        stream.put("m", "middle");
        DomainEvent event = DomainEvent.fromStreamBody("1-0", stream);
        // Canonical key order: 'a', 'm', 'z'.
        String body = new String(event.body(), java.nio.charset.StandardCharsets.UTF_8);
        int aPos = body.indexOf("\"a\":\"first\"");
        int mPos = body.indexOf("\"m\":\"middle\"");
        int zPos = body.indexOf("\"z\":\"last\"");
        assertThat(aPos).isLessThan(mPos).isLessThan(zPos);
        // No whitespace between tokens.
        assertThat(body).doesNotContain(", ");
    }

    @Test
    void itEqualsItselfAcrossConstruction() {
        Map<String, String> stream = new LinkedHashMap<>();
        stream.put("type", "t");
        stream.put("a", "1");
        DomainEvent a = DomainEvent.fromStreamBody("1-0", stream);
        DomainEvent b = DomainEvent.fromStreamBody("1-0", stream);
        // Records don't implement equals if the body array differs in identity; assert content equality.
        assertThat(a.body()).containsExactly(b.body());
        assertThat(a.id()).isEqualTo(b.id());
    }
}
