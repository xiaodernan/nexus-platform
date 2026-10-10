package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;

/**
 * {@code GET /api/v1/me/export} (§106 portability) — the privacy door no test in this repository had ever
 * opened, on the assumption that a route which assembles a payload cannot be wrong.
 *
 * <p>The assumption did not survive the census. HEAD's javadoc for this route promised "assembled JSON of
 * everything the platform holds about this user", while the schema links 28 distinct
 * {@code (table.column)} pairs to {@code users} - 25 of them foreign keys, 19 found by the actor-column
 * names, 28 once the two readings are joined - and 19 of those 28 are rows that belong to the person (the 16
 * the foreign key declares plus the three actor columns
 * that carry none). HEAD's route hand-listed twelve list sections and served eleven of those nineteen; the
 * eight it never read are the memberships, the cart, the external principals, the AI's recommendation sets
 * and agent runs, the feedback signals, the referral invites and the audit trail - and the cart lines were
 * unreachable as well, because their parent cart was not served either. Case 1 below therefore does not
 * compare the payload to a list this file invented: it derives the population from {@code pg_constraint} and
 * the column-name census, and a migration that links a new table to a person has to be classified as
 * exported or as named-out before this door goes green again.
 *
 * <p>The other cases witness what the walk found once the sections existed: the row cap was silent (the
 * contract row for this route promises "streaming JSON of all personal data" while the route read 500 rows
 * per section with nothing in the file saying it
 * stopped), every {@code jsonb} column arrived as the driver's wrapper rather than as JSON, and the two
 * exclusions a portable file has to make deliberately — the credential hash on an external principal, and
 * the {@code before}/{@code after} images on an audit row, which describe the record that was edited rather
 * than the person who edited it.
 */
class PersonalExportDoorTest extends NexusIntegrationTest {

    private static final Pattern FK_COLUMN = Pattern.compile("FOREIGN KEY \\((\\w+)\\)");

    /** The payload key each schema link to a person is served under. */
    private static final Map<String, String> EXPORTED = Map.ofEntries(
            Map.entry("user_preferences.user_id", "preferences"),
            Map.entry("favorites.user_id", "favorites"),
            Map.entry("saved_searches.user_id", "saved_searches"),
            Map.entry("user_identities.user_id", "identities"),
            Map.entry("orders.user_id", "orders"),
            Map.entry("reservations.user_id", "reservations"),
            Map.entry("reviews.user_id", "reviews"),
            Map.entry("conversations.user_id", "conversations"),
            Map.entry("notifications.user_id", "notifications"),
            Map.entry("deletion_requests.user_id", "deletion_requests"),
            Map.entry("merchant_users.user_id", "memberships"),
            Map.entry("carts.user_id", "carts"),
            Map.entry("recommendation_sets.user_id", "recommendation_sets"),
            Map.entry("feedback_events.user_id", "feedback_events"),
            Map.entry("external_principals.linked_user_id", "external_principals"),
            Map.entry("referrals.invitee_id", "referral_invites"),
            Map.entry("agent_runs.user_id", "agent_runs"),
            Map.entry("audit_logs.actor_id", "audit_trail"),
            Map.entry("events.actor_id", "events"));

    /** The links that stay out, and why — named so the absence is a decision rather than an oversight. */
    private static final Map<String, String> NAMED_OUT = Map.ofEntries(
            Map.entry("permission_grants.granted_by", "who signed the grant — the platform's accountability record"),
            Map.entry("refunds.approved_by", "who signed the refund — the row is about the refund"),
            Map.entry("moderation_cases.assigned_to", "who owns the case — the row is about the case"),
            Map.entry("campaigns.approved_by", "who approved the campaign — the row is about the campaign"),
            Map.entry("coupons.created_by", "who drafted the coupon — the row is about the coupon"),
            Map.entry("coupons.published_by", "who published the coupon — the row is about the coupon"),
            Map.entry("seo_pages.reviewed_by", "who reviewed the page — the row is about the page"),
            Map.entry("collections.author_id", "authorship of published content, not a claim about the author"),
            Map.entry("share_links.created_by", "authorship of a share link, not a claim about the sharer"));

    /**
     * An audit row picked by its action, not by its position. {@code audit_trail} orders by {@code created_at
     * desc}, and the export's own {@code export_data} row is written in the same millisecond as the fixture
     * row, so a positional read is a coin toss between two rows that are both really there.
     */
    private JsonNode auditRow(JsonNode payload, String action) {
        List<JsonNode> hits = new ArrayList<>();
        payload.path("audit_trail").forEach(row -> {
            if (action.equals(row.path("action").asText())) {
                hits.add(row);
            }
        });
        assertThat(hits).as("exactly one audit_trail row carries action %s", action).hasSize(1);
        return hits.get(0);
    }

    private JsonNode export(Tenant tenant, UUID person) {
        var answer = get(tenant, token(tenant, person, "consumer"), "/api/v1/me/export");
        assertThat(answer.getStatusCode()).as("export said: %s", answer.getBody()).isEqualTo(HttpStatus.OK);
        return Json.tree(answer.getBody());
    }

    /** A cart line has to point at something, and the schema makes that an offering or a reservation. */
    private UUID newOffering(Tenant tenant, UUID merchant, String slug) {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into offerings (id, merchant_id, tenant_id, kind, slug, name, price_amount, price_model,"
                        + " status) values (:id, :m, :t, 'product', :slug, :name, 88.00, 'fixed', 'published')",
                new MapSqlParameterSource("id", id).addValue("m", merchant).addValue("t", tenant.id())
                        .addValue("slug", slug).addValue("name", slug));
        return id;
    }

    /** Every {@code (table.column)} the schema links to a person, by foreign key and by column name. */
    private Set<String> personLinkedColumns() {
        Set<String> columns = new LinkedHashSet<>();
        jdbc.queryForList("select conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def"
                        + " from pg_constraint where contype = 'f' and confrelid = 'public.users'::regclass",
                new MapSqlParameterSource())
                .forEach(r -> {
                    Matcher m = FK_COLUMN.matcher(String.valueOf(r.get("def")));
                    assertThat(m.find()).as("no column parsed out of %s", r.get("def")).isTrue();
                    columns.add(r.get("tbl") + "." + m.group(1));
                });
        jdbc.queryForList("select table_name as tbl, column_name as col from information_schema.columns"
                        + " where table_schema = 'public' and column_name in"
                        + " ('user_id','actor_id','linked_user_id','invitee_id')", new MapSqlParameterSource())
                .forEach(r -> columns.add(r.get("tbl") + "." + r.get("col")));
        return columns;
    }

    @Test
    @DisplayName("The export's sections are the schema's own links to a person, classified not hand-listed")
    void everyPersonLinkIsExportedOrNamedOut() {
        Tenant tenant = newTenant("export-population");
        UUID person = newUser(tenant, "census@export.test", "consumer");
        JsonNode payload = export(tenant, person);

        Set<String> population = personLinkedColumns();
        assertThat(population).as("the schema links no column to a person — the census read nothing")
                .isNotEmpty();

        Set<String> unclassified = new LinkedHashSet<>(population);
        unclassified.removeAll(EXPORTED.keySet());
        unclassified.removeAll(NAMED_OUT.keySet());
        assertThat(unclassified)
                .as("a column links rows to a person and neither this route serves it nor this file names it out")
                .isEmpty();
        // The two sets must partition the population: a declared exemption for a link the schema no longer
        // makes is as much a lie as an unclassified link.
        assertThat(EXPORTED.keySet()).as("an exported section names a link the schema does not make")
                .isSubsetOf(population);
        assertThat(NAMED_OUT.keySet()).as("a named-out exemption names a link the schema does not make")
                .isSubsetOf(population);

        EXPORTED.values().forEach(key ->
                assertThat(payload.has(key)).as("section %s is absent from the payload", key).isTrue());
        assertThat(payload.path("user_id").asText())
                .as("the file says whose data it is")
                .isEqualTo(person.toString());
    }

    @Test
    @DisplayName("The nine sections §106 promised and the route omitted carry this person's rows, not the tenant's")
    void omittedSectionsServeThePersonsRows() {
        Tenant tenant = newTenant("export-sections");
        UUID person = newUser(tenant, "guest@export.test", "consumer");
        UUID neighbour = newUser(tenant, "neighbour@export.test", "consumer");
        UUID merchant = newMerchant(tenant, "export-cafe", "published");

        staff(tenant, merchant, person);
        staff(tenant, merchant, neighbour);
        jdbc.update("insert into external_principals (protocol, client_id, name, merchant_id, scopes, key_hash,"
                        + " linked_user_id) values ('ucp', :client, 'Partner Agent', :m, array['read'],:hash, :u)",
                new MapSqlParameterSource("client", "client-" + System.nanoTime()).addValue("m", merchant)
                        .addValue("hash", "hash-never-exported").addValue("u", person));
        UUID cart = UUID.randomUUID();
        UUID dish = newOffering(tenant, merchant, "export-dish");
        jdbc.update("insert into carts (id, tenant_id, user_id, status) values (:id, :t, :u, 'open')",
                new MapSqlParameterSource("id", cart).addValue("t", tenant.id()).addValue("u", person));
        jdbc.update("insert into cart_items (id, cart_id, offering_id, kind, quantity, unit_price, options)"
                        + " values (:id, :cart, :dish, 'product', 2, 88.00, cast(:options as jsonb))",
                new MapSqlParameterSource("id", UUID.randomUUID()).addValue("cart", cart).addValue("dish", dish)
                        .addValue("options", Json.write(Json.map("note", "no scallion"))));
        jdbc.update("insert into recommendation_sets (id, tenant_id, user_id, query, intent, strategy, items)"
                        + " values (:id, :t, :u, 'quiet dinner', cast(:intent as jsonb), 'hybrid_v1',"
                        + " cast(:items as jsonb))",
                new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id()).addValue("u", person)
                        .addValue("intent", Json.write(Json.map("district", "sha-tin")))
                        .addValue("items", Json.write(java.util.List.of(Json.map("offering_id", dish)))));
        jdbc.update("insert into feedback_events (id, tenant_id, user_id, subject_type, subject_id, signal, value)"
                        + " values (:id, :t, :u, 'offering', :subject, 'thumbs_up', cast(:value as jsonb))",
                new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id()).addValue("u", person)
                        .addValue("subject", dish).addValue("value", Json.write(Json.map("source", "search"))));
        jdbc.update("insert into agent_runs (id, tenant_id, user_id, agent, status, plan, input_summary)"
                        + " values (:id, :t, :u, 'search_agent', 'succeeded', cast(:plan as jsonb), :input)",
                new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id()).addValue("u", person)
                        .addValue("plan", Json.write(Json.map("steps", java.util.List.of("retrieve", "rank"))))
                        .addValue("input", "quiet dinner for four"));
        jdbc.update("insert into referrals (id, tenant_id, kind, referrer_type, referrer_id, invitee_id, code,"
                        + " invitee_email, status, reward) values (:id, :t, 'invite', 'user', :referrer, :invitee,"
                        + " :code, :email, 'converted', cast(:reward as jsonb))",
                new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id())
                        .addValue("referrer", neighbour).addValue("invitee", person)
                        .addValue("code", "FRIEND" + System.nanoTime()).addValue("email", "guest@export.test")
                        .addValue("reward", Json.write(Json.map("credits", 50))));
        jdbc.update("insert into audit_logs (tenant_id, actor_type, actor_id, action, subject_type, subject_id, ip,"
                        + " user_agent, before, after) values (:t, 'user', :u, 'cancel_reservation', 'reservation',"
                        + " :subject, cast(:ip as inet), 'curl/8', cast(:before as jsonb), cast(:after as jsonb))",
                new MapSqlParameterSource("t", tenant.id()).addValue("u", person).addValue("subject", merchant)
                        .addValue("ip", "203.0.113.7")
                        .addValue("before", Json.write(Json.map("status", "confirmed", "holder", "another person")))
                        .addValue("after", Json.write(Json.map("status", "cancelled"))));
        jdbc.update("insert into notifications (tenant_id, audience, user_id, channel, template, payload)"
                        + " values (:t, 'consumer', :u, 'in_app', 'reservation_confirmed',"
                        + " cast(:payload as jsonb))",
                new MapSqlParameterSource("t", tenant.id()).addValue("u", person)
                        .addValue("payload", Json.write(Json.map("greeting", "您的餐桌已确认"))));

        JsonNode payload = export(tenant, person);

        // A section HEAD already served, so the jsonb encoding is measured against the old code too.
        assertThat(payload.path("notifications").get(0).path("payload").path("greeting").asText())
                .as("a jsonb column arrives as JSON, not as the driver's wrapper: %s",
                        payload.path("notifications").get(0).path("payload"))
                .isEqualTo("您的餐桌已确认");

        // Named before they are read, so a missing section reports its own name instead of a null dereference.
        List<String> filled = List.of("memberships", "external_principals", "carts", "cart_items",
                "recommendation_sets", "feedback_events", "agent_runs", "referral_invites", "audit_trail");
        assertThat(filled.stream().filter(key -> payload.path(key).isEmpty()).toList())
                .as("every section this person has a row in carries that row")
                .isEmpty();

        assertThat(payload.path("memberships")).as("memberships read the whole tenant")
                .hasSize(1);
        assertThat(payload.path("memberships").get(0).path("role").asText()).isEqualTo("manager");
        assertThat(payload.path("external_principals").get(0).path("protocol").asText()).isEqualTo("ucp");
        assertThat(payload.path("external_principals").get(0).path("scopes").isArray())
                .as("an array column is a JSON list — left as the driver's object it reaches the connection"
                        + " and fails the whole response: %s",
                        payload.path("external_principals").get(0).path("scopes"))
                .isTrue();
        assertThat(payload.path("external_principals").get(0).path("scopes").get(0).asText()).isEqualTo("read");
        assertThat(payload.path("carts").get(0).path("status").asText()).isEqualTo("open");
        assertThat(payload.path("cart_items").get(0).path("options").path("note").asText())
                .as("a jsonb column arrives as JSON, not as the driver's wrapper")
                .isEqualTo("no scallion");
        assertThat(payload.path("recommendation_sets").get(0).path("intent").path("district").asText())
                .isEqualTo("sha-tin");
        assertThat(payload.path("recommendation_sets").get(0).path("items").isArray()).isTrue();
        assertThat(payload.path("feedback_events").get(0).path("signal").asText()).isEqualTo("thumbs_up");
        assertThat(payload.path("agent_runs").get(0).path("plan").path("steps").get(0).asText())
                .as("the AI's own plan for this person is their data")
                .isEqualTo("retrieve");
        assertThat(payload.path("agent_runs").get(0).path("input_summary").asText()).isEqualTo("quiet dinner for four");
        assertThat(payload.path("referral_invites").get(0).path("status").asText()).isEqualTo("converted");
        assertThat(payload.path("referral_invites").get(0).has("referrer_id")).isFalse();
        assertThat(auditRow(payload, "cancel_reservation").path("ip").asText())
                .as("the actor's own ip and when are their data")
                .isEqualTo("203.0.113.7");

        // The neighbour's rows are not this person's file: the same merchant, the same tenant, other rows.
        assertThat(export(tenant, neighbour).path("referral_invites")).as("the referrer is not the invitee")
                .isEmpty();
        assertThat(export(tenant, neighbour).path("carts")).isEmpty();
        assertThat(export(tenant, neighbour).path("agent_runs")).isEmpty();
    }

    @Test
    @DisplayName("A section that hit the row cap says so instead of presenting a prefix as the whole file")
    void theRowCapIsDisclosed() {
        Tenant tenant = newTenant("export-cap");
        UUID person = newUser(tenant, "busy@export.test", "consumer");
        // 501 events: one more than the cap, so the only honest answer names the truncation.
        jdbc.update("insert into events (tenant_id, actor_type, actor_id, name, occurred_at)"
                        + " select :t, 'user', :u, 'export_probe', now() from generate_series(1, 501)",
                new MapSqlParameterSource("t", tenant.id()).addValue("u", person));

        JsonNode payload = export(tenant, person);
        int limit = payload.path("row_limit").asInt();

        assertThat(limit).as("the file states the cap it read with").isPositive();
        assertThat(payload.path("section_sizes").path("events").asInt()).isEqualTo(limit);
        assertThat(payload.path("possibly_truncated"))
                .as("the truncated list names the sections that filled the cap")
                .extracting(node -> node.asText()).contains("events");
        assertThat(payload.path("possibly_truncated"))
                .as("a section nobody populated is not reported as truncated")
                .extracting(node -> node.asText()).doesNotContain("carts");
        assertThat(count("select count(*) from events where actor_id = :u", Map.of("u", person)))
                .as("the cap hides rows that exist: 501 written, %s reported", payload.path("section_sizes")
                        .path("events").asInt())
                .isGreaterThan(limit);
    }

    @Test
    @DisplayName("What a portable file must not carry: a credential hash and another person's row image")
    void secretsAndRowImagesStayOut() {
        Tenant tenant = newTenant("export-secret");
        UUID person = newUser(tenant, "private@export.test", "consumer");
        UUID merchant = newMerchant(tenant, "export-secret-cafe", "published");
        jdbc.update("insert into external_principals (protocol, client_id, name, merchant_id, linked_user_id,"
                        + " key_hash) values ('ucp', :client, 'Partner Agent', :m, :u, :hash)",
                new MapSqlParameterSource("client", "client-" + System.nanoTime()).addValue("m", merchant)
                        .addValue("u", person).addValue("hash", "LEAKED-HASH-MARKER"));
        jdbc.update("insert into audit_logs (tenant_id, actor_type, actor_id, action, subject_type, subject_id,"
                        + " before, after) values (:t, 'user', :u, 'update_user', 'user', :subject,"
                        + " cast(:before as jsonb), cast(:after as jsonb))",
                new MapSqlParameterSource("t", tenant.id()).addValue("u", person).addValue("subject", merchant)
                        .addValue("before", Json.write(Json.map("email", "someone-else@example.test")))
                        .addValue("after", Json.write(Json.map("email", "another-person@example.test"))));

        String body = export(tenant, person).toString();

        assertThat(body).as("a hash of a credential is still credential-shaped").doesNotContain("LEAKED-HASH-MARKER");
        assertThat(body).as("the audit row's images describe the record, not the actor")
                .doesNotContain("someone-else@example.test").doesNotContain("another-person@example.test");

        JsonNode payload = export(tenant, person);
        List<String> sections = List.of("external_principals", "audit_trail");
        assertThat(sections.stream().filter(key -> !payload.path(key).isArray()).toList())
                .as("a section this person has rows in is served as a list")
                .isEmpty();
        assertThat(payload.path("external_principals").get(0).has("key_hash")).isFalse();
        List<String> actions = new ArrayList<>();
        payload.path("audit_trail").forEach(row -> actions.add(row.path("action").asText()));
        assertThat(actions).as("the actor's own action is in the file, and so is this read itself")
                .contains("update_user", "export_data");
        assertThat(auditRow(payload, "update_user").path("subject_type").asText()).isEqualTo("user");
    }

    @Test
    @DisplayName("An uncapped section is reported at its true size, and an empty tenant link reads as an empty list")
    void uncappedSectionsAreNotFalselyFlagged() {
        Tenant tenant = newTenant("export-empty");
        UUID person = newUser(tenant, "bare@export.test", "consumer");

        JsonNode payload = export(tenant, person);

        Map<String, String> missing = new LinkedHashMap<>();
        EXPORTED.forEach((link, key) -> {
            if (!payload.path(key).isArray()) {
                missing.put(link, key);
            }
        });
        assertThat(missing).as("a section a bare account has no rows for must still be an empty array").isEmpty();
        assertThat(payload.path("row_limit").isNumber())
                .as("the cap the file was read with is stated as a number, not omitted")
                .isTrue();
        assertThat(payload.path("possibly_truncated").isArray())
                .as("the truncation disclosure is a list, and an absent one is not an empty one")
                .isTrue();
        assertThat(payload.path("possibly_truncated")).as("a bare account filled no cap").isEmpty();

        // Derived from the payload's own shape: any list the file serves has to size itself, so a section
        // added later without a size reddens here instead of quietly becoming an undisclosed count.
        List<String> unsized = new ArrayList<>();
        payload.fields().forEachRemaining(field -> {
            if (field.getValue().isArray() && !"possibly_truncated".equals(field.getKey())
                    && !payload.path("section_sizes").has(field.getKey())) {
                unsized.add(field.getKey());
            }
        });
        assertThat(unsized).as("every list section states its own size in section_sizes").isEmpty();
        assertThat(payload.path("section_sizes").isObject())
                .as("the sizes map is an object, not a driver wrapper: %s", payload.path("section_sizes"))
                .isTrue();
        assertThat(payload.path("deletion_requests").isArray())
                .as("deletion_requests is a list, and a bare account gets an empty one rather than null: %s",
                        payload.path("deletion_requests"))
                .isTrue();
        assertThat(payload.path("exported_at").asText()).isNotBlank();
    }
}
