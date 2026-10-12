package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.test.context.ActiveProfiles;

/**
 * {@code DELETE /api/v1/me} (§106 erasure) — walked for the first time, on the assumption that a statement
 * which names its own columns cannot be wrong about them.
 *
 * <p>It was wrong in three ways, all found by measuring instead of reading. (1) HEAD's audit detail named
 * {@code email, phone, password_hash, display_name} while the very same request rewrote eight columns of the
 * row: {@code avatar_url} carried the person's picture URL out of the account and was never disclosed,
 * because the audit list was typed by hand next to a hand-typed statement and the two had no reason to agree.
 * (2) The response said "Personal identifiers were erased" while the person's own email address was still
 * sitting in {@code user_identities.provider_id} — written there by {@code AuthService.register} for every
 * password account, and by {@code demo()} too — plus seven more copies in the tenant. (3) That surviving link
 * row was not merely a retained copy: {@code AuthService.oauth} resolves a returning subject through it and
 * only provisions an account when no link exists, so an erased person signing in again with a provider hit
 * the deleted row and got {@code user_not_found} for good, while re-registering the same address had its
 * {@code linkIdentity} swallowed by {@code on conflict ... do nothing}. The schema already disagreed with
 * that outcome: {@code user_identities.user_id} is declared {@code ON DELETE CASCADE}, and
 * {@code users_email_tenant_uniq} is a partial index that excludes deleted rows precisely so an erased
 * address can be taken again.
 *
 * <p>So the erasure now declares its columns once ({@code IdentityRepository.ERASURE}), that declaration
 * builds the SQL, the audit detail and the response, and the erasure deletes the person's identity links.
 * The cases below read the lists back as observations rather than as strings: the changed-column set comes
 * from a before/after read of the whole row, the personal-carrier set from whichever columns' before-images
 * actually held a planted contact value, and the bookkeeping set from a value-preserving update — which is
 * how the {@code users_updated_at} trigger's own footprint is measured instead of typed, so this file does
 * not commit the sin it is auditing.
 */
@ActiveProfiles("test")
class PersonalEraseDoorTest extends NexusIntegrationTest {

    /**
     * The columns that keep a copy of the person's contact values after this door, each with the reason it
     * stays. The census below requires survivors to equal exactly this set, in both directions: a new copy
     * column that is not classified reddens, and so does an exemption whose row no longer carries a copy
     * (which is what makes deleting the identity links a decision the file has to keep up with rather than a
     * claim it can forget).
     */
    private static final Map<String, String> COPIES_LEFT = new LinkedHashMap<>(Map.ofEntries(
            Map.entry("audit_logs.after", "the platform's own trail keeps the row image it was handed"),
            Map.entry("events.properties", "an analytics event records the visit as it happened"),
            Map.entry("notifications.payload", "a message already sent cannot be unsent"),
            Map.entry("referrals.invitee_email", "a growth row about an invite, filed before any account existed"),
            Map.entry("reservations.contact", "the merchant's booking record; §106 keeps transaction rows"),
            Map.entry("saved_searches.intent", "the person's own row, deferred to the §106 retention sweep"),
            Map.entry("user_preferences.value", "the person's own row, deferred to the §106 retention sweep")));

    /** A person, and the strings this file planted as their contact values. */
    private record Person(UUID id, String email, String phone, String displayName, String avatarUrl,
                          String passwordHash, String marker) {
    }

    /** The marker is alphanumeric only: it goes into {@code ilike} patterns, where {@code %} and {@code _} are wildcards. */
    private Person plantPerson(Tenant tenant) {
        String marker = "erase" + System.nanoTime();
        String email = marker + "@example.test";
        String phone = "+852-9" + marker.substring("erase".length());
        UUID id = UUID.randomUUID();
        jdbc.update("""
                insert into users (id, tenant_id, email, phone, password_hash, display_name, avatar_url, locale,
                                   role, status, marketing_opt_in)
                values (:id, :t, :email, :phone, :hash, :display, :avatar, 'en', 'consumer', 'active', true)
                """, new MapSqlParameterSource("id", id).addValue("t", tenant.id()).addValue("email", email)
                .addValue("phone", phone).addValue("hash", "bcrypt$" + marker)
                .addValue("display", "Erased " + marker).addValue("avatar", "https://cdn.example.test/" + marker
                        + ".png"));
        return new Person(id, email, phone, "Erased " + marker, "https://cdn.example.test/" + marker + ".png",
                "bcrypt$" + marker, marker);
    }

    private static String shortId(UUID id) {
        return id.toString().substring(0, 8);
    }

    private void plantLink(Tenant tenant, UUID person, String provider, String providerId) {
        jdbc.update("insert into user_identities (user_id, tenant_id, provider, provider_id, verified_at)"
                        + " values (:u, :t, :provider, :pid, now())",
                new MapSqlParameterSource("u", person).addValue("t", tenant.id()).addValue("provider", provider)
                        .addValue("pid", providerId));
    }

    /**
     * One legal row in every table that can hold a copy of this person's contact values, so each exemption
     * above is exercised by a real survivor rather than asserted against a population that never had one.
     *
     * <p>The business identifiers (merchant and offering slugs, order and reservation codes) are deliberately
     * <em>not</em> built from the marker: the census scans for the marker, and a slug that happened to carry it
     * would be counted as a copy of the person's contact details. Codes come from the row's own uuid instead.
     */
    private Map<String, UUID> plantCopies(Tenant tenant, Person person) {
        UUID merchant = newMerchant(tenant, "erase-cafe", "published");
        UUID offering = UUID.randomUUID();
        jdbc.update("insert into offerings (id, merchant_id, tenant_id, kind, slug, name, price_amount,"
                        + " price_model, status) values (:id, :m, :t, 'product', :slug, :name, 88.00, 'fixed',"
                        + " 'published')",
                new MapSqlParameterSource("id", offering).addValue("m", merchant).addValue("t", tenant.id())
                        .addValue("slug", "erase-dish-" + shortId(offering)).addValue("name", "Erasure dish"));
        UUID order = UUID.randomUUID();
        jdbc.update("insert into orders (id, code, tenant_id, merchant_id, user_id, status, fulfillment, total,"
                        + " currency) values (:id, :code, :t, :m, :u, 'paid', 'delivery', 128.00, 'HKD')",
                new MapSqlParameterSource("id", order).addValue("code", "ORD-" + shortId(order))
                        .addValue("t", tenant.id()).addValue("m", merchant).addValue("u", person.id()));
        UUID reservation = UUID.randomUUID();
        jdbc.update("insert into reservations (id, code, tenant_id, merchant_id, user_id, party_size, contact,"
                        + " starts_at, status, currency, source) values (:id, :code, :t, :m, :u, 4,"
                        + " cast(:contact as jsonb), now() + interval '1 day', 'confirmed', 'HKD', 'web')",
                new MapSqlParameterSource("id", reservation).addValue("code", "RES-" + shortId(reservation))
                        .addValue("t", tenant.id()).addValue("m", merchant).addValue("u", person.id())
                        .addValue("contact", Json.write(Json.map("email", person.email(), "phone", person.phone(),
                                "name", person.displayName()))));
        jdbc.update("insert into referrals (id, tenant_id, kind, referrer_type, referrer_id, invitee_id, code,"
                        + " invitee_email, status, reward) values (:id, :t, 'invite', 'user', :referrer, :invitee,"
                        + " :code, :email, 'converted', cast(:reward as jsonb))",
                new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id())
                        .addValue("referrer", person.id()).addValue("invitee", person.id())
                        .addValue("code", "FR" + shortId(UUID.randomUUID())).addValue("email", person.email())
                        .addValue("reward", Json.write(Json.map("credits", 50))));
        jdbc.update("insert into notifications (tenant_id, audience, user_id, channel, template, payload)"
                        + " values (:t, 'consumer', :u, 'email', 'order_receipt', cast(:payload as jsonb))",
                new MapSqlParameterSource("t", tenant.id()).addValue("u", person.id())
                        .addValue("payload", Json.write(Json.map("to", person.email(), "greeting",
                                "Your table is confirmed"))));
        jdbc.update("insert into audit_logs (tenant_id, actor_type, actor_id, action, subject_type, subject_id,"
                        + " before, after) values (:t, 'user', :u, 'update_user', 'user', :subject,"
                        + " cast(:before as jsonb), cast(:after as jsonb))",
                new MapSqlParameterSource("t", tenant.id()).addValue("u", person.id())
                        .addValue("subject", merchant).addValue("before", Json.write(Json.map("phone", null)))
                        .addValue("after", Json.write(Json.map("email", person.email(), "phone", person.phone()))));
        jdbc.update("insert into events (event_id, tenant_id, actor_type, actor_id, name, properties, context)"
                        + " values (:id, :t, 'user', :u, 'erase_probe', cast(:properties as jsonb),"
                        + " cast(:context as jsonb))",
                new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id())
                        .addValue("u", person.id())
                        .addValue("properties", Json.write(Json.map("contact", person.email())))
                        .addValue("context", Json.write(Json.map("source", "web"))));
        jdbc.update("insert into favorites (user_id, subject_type, subject_id) values (:u, 'offering', :o)",
                new MapSqlParameterSource("u", person.id()).addValue("o", offering));
        jdbc.update("insert into saved_searches (user_id, query, intent, notify) values (:u, :query,"
                        + " cast(:intent as jsonb), false)",
                new MapSqlParameterSource("u", person.id()).addValue("query", "quiet dinner")
                        .addValue("intent", Json.write(Json.map("contact", person.email()))));
        jdbc.update("insert into user_preferences (user_id, kind, key, value) values (:u, 'probe', 'contact',"
                        + " cast(:value as jsonb))",
                new MapSqlParameterSource("u", person.id())
                        .addValue("value", Json.write(Json.map("email", person.email()))));
        jdbc.update("insert into carts (id, tenant_id, user_id, status) values (:id, :t, :u, 'open')",
                new MapSqlParameterSource("id", UUID.randomUUID()).addValue("t", tenant.id())
                        .addValue("u", person.id()));
        return Map.of("merchant", merchant, "offering", offering, "order", order, "reservation", reservation);
    }

    // ---------------------------------------------------------------- reads

    private JsonNode userRow(UUID id) {
        Map<String, Object> record = row("select to_jsonb(u)::text as doc from users u where u.id = :id",
                Map.of("id", id));
        return Json.tree(String.valueOf(record.get("doc")));
    }

    /** Every column of {@code users}, straight from the catalogue — the map this file compares rows with. */
    private Set<String> usersColumns() {
        Set<String> columns = new LinkedHashSet<>();
        jdbc.queryForList("select column_name as col from information_schema.columns where table_schema ="
                        + " 'public' and table_name = 'users' order by ordinal_position", new MapSqlParameterSource())
                .forEach(r -> columns.add(String.valueOf(r.get("col"))));
        return columns;
    }

    private static Set<String> changed(JsonNode before, JsonNode after, Set<String> columns) {
        Set<String> moved = new LinkedHashSet<>();
        for (String column : columns) {
            if (!before.path(column).toString().equals(after.path(column).toString())) {
                moved.add(column);
            }
        }
        return moved;
    }

    /** Derived, not typed: whichever columns' before-images held a planted contact value carry personal data. */
    private Set<String> personalCarriers(JsonNode before, Person person, Set<String> columns) {
        List<String> planted = List.of(person.email(), person.phone(), person.displayName(), person.avatarUrl(),
                person.passwordHash());
        Set<String> carriers = new LinkedHashSet<>();
        for (String column : columns) {
            String value = before.path(column).asText("");
            if (planted.stream().anyMatch(value::contains)) {
                carriers.add(column);
            }
        }
        return carriers;
    }

    private static List<String> textList(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(node -> out.add(node.asText()));
        return out;
    }

    /** The one {@code delete_data} audit row's metadata, read as JSON. */
    private JsonNode eraseAuditRow(Tenant tenant, UUID person) {
        List<Map<String, Object>> hits = jdbc.queryForList("select metadata::text as md from audit_logs"
                        + " where action = 'delete_data' and actor_id = :u and tenant_id = :t",
                new MapSqlParameterSource("u", person).addValue("t", tenant.id()));
        assertThat(hits).as("the erasure files exactly one audit row").hasSize(1);
        return Json.tree(String.valueOf(hits.get(0).get("md")));
    }

    // ---------------------------------------------------------------- the door

    private JsonNode erase(Tenant tenant, UUID person) {
        return erase(tenant, token(tenant, person, "consumer"));
    }

    private JsonNode erase(Tenant tenant, String bearer) {
        ResponseEntity<String> answer = exchange(HttpMethod.DELETE, tenant, bearer, "/api/v1/me", null);
        assertThat(answer.getStatusCode()).as("DELETE /api/v1/me said: %s", answer.getBody())
                .isEqualTo(HttpStatus.OK);
        return Json.tree(answer.getBody());
    }

    /** An {@code id_token} the dev verifier will read: it decodes the payload and never checks the signature. */
    private static String devIdToken(String subject, String email, String name) {
        Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
        String header = encoder.encodeToString("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8));
        String payload = encoder.encodeToString(Json.write(Json.map("sub", subject, "email", email, "name", name,
                "locale", "en")).getBytes(StandardCharsets.UTF_8));
        return header + "." + payload + ".";
    }

    private ResponseEntity<String> oauthSignIn(Tenant tenant, String subject, String email) {
        return post(tenant, null, "/api/v1/auth/oauth/dev",
                Json.map("id_token", devIdToken(subject, email, "Erased Person")));
    }

    // ---------------------------------------------------------------- cases

    @Test
    @DisplayName("The columns the response names are the columns the statement moved, measured against the row")
    void responseNamesWhatTheStatementMoved() {
        Tenant tenant = newTenant("erase-columns");
        Person person = plantPerson(tenant);
        Set<String> columns = usersColumns();
        JsonNode before = userRow(person.id());

        Set<String> documented = new LinkedHashSet<>();
        before.fieldNames().forEachRemaining(documented::add);
        assertThat(documented).as("the row read covers the catalogue, so no column is invisible to this test")
                .containsExactlyInAnyOrderElementsOf(columns);

        JsonNode answer = erase(tenant, person.id());
        JsonNode after = userRow(person.id());
        Set<String> moved = changed(before, after, columns);

        // A write that changes no value: the schema's own BEFORE UPDATE trigger moves whatever it moves, and
        // this measures those columns instead of this file naming them.
        jdbc.update("update users set locale = :locale where id = :id",
                new MapSqlParameterSource("locale", before.path("locale").asText()).addValue("id", person.id()));
        Set<String> bookkeeping = changed(after, userRow(person.id()), columns);
        assertThat(bookkeeping).as("the value-preserving update moved nothing — the trigger footprint was not"
                + " measured").isNotEmpty();

        List<String> declared = textList(answer.path("erased_columns"));
        assertThat(declared).as("the response names the columns it erased").isNotEmpty();
        assertThat(union(declared, bookkeeping))
                .as("moved=%s but declared=%s and trigger-moved=%s", moved, declared, bookkeeping)
                .containsExactlyInAnyOrderElementsOf(moved);
        assertThat(intersect(declared, bookkeeping))
                .as("a column the trigger moves is also claimed as erased by the statement").isEmpty();

        assertThat(after.path("status").asText()).isEqualTo("deleted");
        assertThat(after.path("deleted_at").isNull()).isFalse();
        assertThat(after.path("marketing_opt_in").asBoolean()).isFalse();
        assertThat(after.path("display_name").asText()).isEqualTo("Deleted user");
    }

    @Test
    @DisplayName("The audit names every column that held a personal value, and no column that did not")
    void auditNamesEveryPersonalCarrier() {
        Tenant tenant = newTenant("erase-audit");
        Person person = plantPerson(tenant);
        Set<String> columns = usersColumns();
        JsonNode before = userRow(person.id());
        Set<String> carriers = personalCarriers(before, person, columns);
        assertThat(carriers).as("the planted contact values were written before the erase — the classifier"
                + " read an empty row").isNotEmpty();

        JsonNode answer = erase(tenant, person.id());
        JsonNode metadata = eraseAuditRow(tenant, person.id());
        Set<String> moved = changed(before, userRow(person.id()), columns);

        assertThat(textList(metadata.path("pii_columns")))
                .as("the audit signed %s while these columns held planted personal values: %s",
                        textList(metadata.path("pii_columns")), carriers)
                .containsExactlyInAnyOrderElementsOf(carriers);
        assertThat(carriers).as("a column holding personal data survived the erasure unchanged")
                .isSubsetOf(moved);
        assertThat(textList(metadata.path("erased_columns")))
                .as("the audit row carries the erased list at all, so the next comparison is not two empties")
                .isNotEmpty();
        assertThat(textList(metadata.path("erased_columns")))
                .as("the audit and the response answer for the same set")
                .containsExactlyInAnyOrderElementsOf(textList(answer.path("erased_columns")));
        assertThat(metadata.path("kind").asText()).isEqualTo("account");
    }

    @Test
    @DisplayName("No copy of the person survives anywhere in their own row, in any column the catalogue knows")
    void theUsersRowCarriesNoCopy() {
        Tenant tenant = newTenant("erase-row");
        Person person = plantPerson(tenant);
        assertThat(userRow(person.id()).toString()).as("the fixture planted nothing the scan could find")
                .contains(person.marker());

        erase(tenant, person.id());

        String after = userRow(person.id()).toString();
        assertThat(after).as("the erased row still carries the marker: %s", after).doesNotContain(person.marker());
    }

    @Test
    @DisplayName("The identity links die with the account, including the email the register flow filed there")
    void identityLinksDieWithTheAccount() {
        Tenant tenant = newTenant("erase-links");
        Person person = plantPerson(tenant);
        String subject = "subject-" + person.marker();
        plantLink(tenant, person.id(), "password", person.email());
        plantLink(tenant, person.id(), "dev", subject);
        assertThat(count("select count(*) from user_identities where user_id = :u", Map.of("u", person.id())))
                .as("two links planted").isEqualTo(2);

        JsonNode answer = erase(tenant, person.id());

        assertThat(answer.path("identity_links_removed").asInt())
                .as("the response counts the links it removed: %s", answer)
                .isEqualTo(2);
        assertThat(count("select count(*) from user_identities where user_id = :u", Map.of("u", person.id())))
                .as("the person's own identity rows are gone").isZero();
        assertThat(count("select count(*) from user_identities where provider_id = :e",
                Map.of("e", person.email())))
                .as("the email the register flow writes into provider_id is not held after erasure")
                .isZero();
        assertThat(count("select count(*) from user_identities where provider_id = :s", Map.of("s", subject)))
                .as("the provider's subject id is gone with it").isZero();
    }

    @Test
    @DisplayName("An erased subject who signs in through the provider again gets a fresh account, not a dead link")
    void erasedSubjectCanSignInAgain() {
        Tenant tenant = newTenant("erase-oauth");
        String subject = "subject-" + System.nanoTime();
        String email = "oauth-" + subject + "@example.test";

        ResponseEntity<String> first = oauthSignIn(tenant, subject, email);
        assertThat(first.getStatusCode()).as("first sign-in: %s", first.getBody()).isEqualTo(HttpStatus.OK);
        UUID userId = UUID.fromString(Json.tree(first.getBody()).path("user").path("id").asText());
        assertThat(count("select count(*) from user_identities where provider = 'dev' and provider_id = :s",
                Map.of("s", subject))).as("the sign-in filed the link row").isEqualTo(1);

        erase(tenant, userId);

        ResponseEntity<String> again = oauthSignIn(tenant, subject, email);
        assertThat(again.getStatusCode())
                .as("a returning subject whose account was erased must be provisioned again, not left pointing"
                        + " at the erased row: %s", again.getBody())
                .isEqualTo(HttpStatus.OK);
        JsonNode body = Json.tree(again.getBody());
        assertThat(body.path("oauth").path("account_created").asBoolean())
                .as("the second sign-in creates a new account: %s", body).isTrue();
        assertThat(body.path("user").path("id").asText()).isNotEqualTo(userId.toString());
        assertThat(count("select count(*) from user_identities where user_id = :u", Map.of("u", userId)))
                .as("no link still points at the erased row").isZero();
    }

    @Test
    @DisplayName("Every copy this door leaves behind is named, and nothing unnamed survives")
    void theCopyCensusIsExactlyTheNamedSet() {
        Tenant tenant = newTenant("erase-census");
        Person person = plantPerson(tenant);
        plantLink(tenant, person.id(), "password", person.email());
        plantCopies(tenant, person);
        assertThat(markerSites(person.marker()))
                .as("the marker was written before the erase — a census over an empty fixture proves nothing")
                .containsAll(COPIES_LEFT.keySet());

        erase(tenant, person.id());

        Set<String> survivors = markerSites(person.marker());
        assertThat(survivors).as("a copy survived that no exemption names: %s", survivors)
                .containsExactlyInAnyOrderElementsOf(COPIES_LEFT.keySet());
    }

    @Test
    @DisplayName("Transaction rows stay, the job row is filed, and the response says which is which")
    void accountingStaysAndTheJobRowIsFiled() {
        Tenant tenant = newTenant("erase-accounting");
        Person person = plantPerson(tenant);
        Map<String, UUID> copies = plantCopies(tenant, person);

        JsonNode answer = erase(tenant, person.id());

        assertThat(count("select count(*) from orders where id = :o and user_id = :u",
                Map.of("o", copies.get("order"), "u", person.id()))).as("the order stays for accounting").isEqualTo(1);
        assertThat(count("select count(*) from reservations where id = :r and user_id = :u",
                Map.of("r", copies.get("reservation"), "u", person.id()))).as("the booking stays").isEqualTo(1);
        assertThat(count("select count(*) from carts where user_id = :u", Map.of("u", person.id())))
                .as("the cart row survives with its owner nulled out of users").isEqualTo(1);

        List<Map<String, Object>> jobs = jdbc.queryForList("select kind, status, payload::text as payload"
                + " from deletion_requests where user_id = :u", new MapSqlParameterSource("u", person.id()));
        assertThat(jobs).as("one retention job row is filed for this request").hasSize(1);
        assertThat(jobs.get(0).get("kind")).isEqualTo("account");
        assertThat(jobs.get(0).get("status")).isEqualTo("pending");

        assertThat(answer.path("scope").asText()).isEqualTo("users_row_and_identity_links");
        String notice = answer.path("notice").asText();
        assertThat(notice).as("the notice points at the derived list instead of re-describing it: %s", notice)
                .contains("erased_columns");
        assertThat(notice).as("the notice admits the retention workflow has no runner in this build: %s", notice)
                .contains("no job in this build reads");
        assertThat(notice).as("no sentence here may claim the erasure reached everything")
                .doesNotContain("all personal data", "Personal identifiers were erased");
    }

    @Test
    @DisplayName("A DELETE /me with no credential is refused and inert: nothing erased, nothing filed")
    void anonymousEraseDoesNothing() {
        Tenant tenant = newTenant("erase-anon");
        Person person = plantPerson(tenant);
        Set<String> columns = usersColumns();
        JsonNode before = userRow(person.id());

        ResponseEntity<String> answer = exchange(HttpMethod.DELETE, tenant, null, "/api/v1/me", null);

        assertThat(answer.getStatusCode()).as("body: %s", answer.getBody()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(changed(before, userRow(person.id()), columns))
                .as("a refused erasure must move no column at all").isEmpty();
        assertThat(count("select count(*) from deletion_requests where user_id = :u", Map.of("u", person.id())))
                .as("a refused erasure files no retention job").isZero();
    }

    @Test
    @DisplayName("Erasing one person leaves the next row in the same tenant, and its links, intact")
    void theNeighbourIsNotErased() {
        Tenant tenant = newTenant("erase-neighbour");
        Person person = plantPerson(tenant);
        Person neighbour = plantPerson(tenant);
        plantLink(tenant, person.id(), "password", person.email());
        plantLink(tenant, neighbour.id(), "password", neighbour.email());
        UUID merchant = plantCopies(tenant, person).get("merchant");
        staff(tenant, merchant, person.id());
        staff(tenant, merchant, neighbour.id());
        Set<String> columns = usersColumns();
        JsonNode neighbourBefore = userRow(neighbour.id());

        erase(tenant, person.id());

        assertThat(changed(neighbourBefore, userRow(neighbour.id()), columns))
                .as("the neighbour's row moved at all — the erasure is not keyed on its own id").isEmpty();
        assertThat(count("select count(*) from user_identities where user_id = :u", Map.of("u", neighbour.id())))
                .as("the neighbour keeps its identity link").isEqualTo(1);
        assertThat(count("select count(*) from merchant_users where merchant_id = :m and user_id = :u",
                Map.of("m", merchant, "u", person.id())))
                .as("the erased person's staffing row is about the merchant and stays").isEqualTo(1);
    }

    @Test
    @DisplayName("Register, sign in, erase: the credential dies at the login door and its email copy goes with it")
    void erasedCredentialIsDeadAtTheLoginDoor() {
        Tenant tenant = newTenant("erase-login");
        // This case walks the register door itself, so the account is created by the request rather than by
        // plantPerson: pre-inserting the address would make the registration a 409 about this fixture.
        String email = "door-" + System.nanoTime() + "@example.test";
        String password = "erase-door-password";

        ResponseEntity<String> registered = post(tenant, null, "/api/v1/auth/register",
                // The contract's snake_case field names: AuthController binds a record whose components are
                // display_name and accept_terms, so a camelCase body is a 422 about this file, not about the door.
                Json.map("email", email, "password", password, "display_name", "Door Fixture",
                        "locale", "en", "accept_terms", true));
        assertThat(registered.getStatusCode()).as("register: %s", registered.getBody()).isEqualTo(HttpStatus.OK);
        String bearer = Json.tree(registered.getBody()).path("access_token").asText();
        assertThat(post(tenant, null, "/api/v1/auth/login", Json.map("email", email, "password", password))
                .getStatusCode()).as("the credential works before the erasure").isEqualTo(HttpStatus.OK);
        assertThat(count("select count(*) from user_identities where provider = 'password' and provider_id = :e",
                Map.of("e", email)))
                .as("register itself files the email as the password identity — the copy this door must take")
                .isEqualTo(1);

        erase(tenant, bearer);

        ResponseEntity<String> refused = post(tenant, null, "/api/v1/auth/login",
                Json.map("email", email, "password", password));
        assertThat(refused.getStatusCode()).as("body: %s", refused.getBody())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(Json.tree(refused.getBody()).path("error").path("code").asText())
                .isEqualTo("invalid_credentials");
        assertThat(count("select count(*) from user_identities where provider_id = :e", Map.of("e", email)))
                .as("no identity row still carries this address after the erasure").isZero();
        assertThat(count("select count(*) from users where email = :e", Map.of("e", email)))
                .as("the users row no longer answers to the address either").isZero();
    }

    // ---------------------------------------------------------------- census helpers

    /**
     * Every {@code (table.column)} in the schema that could hold a copy and currently does, for this marker.
     * The population is the catalogue's own: base tables of a text-family or jsonb type that either carry a
     * tenant, link a row to {@code users} by foreign key, or are named by an actor column.
     *
     * <p>The type is resolved from {@code pg_attribute}, not from {@code information_schema.columns.data_type}:
     * {@code users.email} is a citext <em>domain</em>, which the information schema reports as
     * {@code USER-DEFINED} and a hand-typed spelling list silently drops — the first version of this scan
     * therefore could not see the one column this door erases, and reported the erasure as complete about a
     * population that excluded it (D309). Array columns are resolved to their element type for the same reason:
     * a text array prints its elements into {@code ::text} and can hold a copy.
     */
    private Set<String> markerSites(String marker) {
        List<Map<String, Object>> population = jdbc.queryForList("""
                with typed as (
                    select rel.relname as tbl, att.attname as col,
                           case when t.typtype = 'd'
                                then (select b.typname from pg_type b where b.oid = t.typbasetype)
                                when t.typcategory = 'A' then (select e.typname from pg_type e where e.oid =
                                     case when t.typtype = 'd'
                                          then (select b.typelem from pg_type b where b.oid = t.typbasetype)
                                          else t.typelem end)
                                else t.typname end as holding_type
                    from pg_attribute att
                      join pg_class rel on rel.oid = att.attrelid and rel.relkind = 'r'
                      join pg_namespace nsp on nsp.oid = rel.relnamespace and nsp.nspname = 'public'
                      join pg_type t on t.oid = att.atttypid
                    where att.attnum > 0 and not att.attisdropped
                )
                select tbl as t, col as col
                from typed
                where holding_type in ('text','varchar','citext','jsonb','json')
                  and (exists (select 1 from typed k where k.tbl = typed.tbl and k.col = 'tenant_id')
                       or exists (select 1 from pg_constraint con
                                   join pg_class pc on pc.oid = con.conrelid
                                   join pg_class rt on rt.oid = con.confrelid
                                  where con.contype = 'f' and rt.relname = 'users' and pc.relname = typed.tbl)
                       or col in ('user_id','actor_id','linked_user_id','invitee_id'))
                order by 1, 2
                """, new MapSqlParameterSource());
        Set<String> sites = population.stream()
                .map(r -> r.get("t") + "." + r.get("col"))
                .collect(Collectors.toCollection(LinkedHashSet::new));
        assertThat(sites).as("the scan population cannot see the columns this door is about")
                .contains("users.email", "users.avatar_url", "user_identities.provider_id", "reservations.contact");
        String scan = population.stream()
                .map(r -> "select '" + r.get("t") + "." + r.get("col") + "' as site, count(*) as hits from \""
                        + r.get("t") + "\" where \"" + r.get("col") + "\"::text ilike '%" + marker + "%'")
                .collect(Collectors.joining(" union all "));
        Set<String> holding = new LinkedHashSet<>();
        jdbc.queryForList("select site from (" + scan + ") s where s.hits > 0 order by 1",
                new MapSqlParameterSource()).forEach(r -> holding.add(String.valueOf(r.get("site"))));
        return holding;
    }

    private static Set<String> union(List<String> left, Set<String> right) {
        Set<String> out = new LinkedHashSet<>(left);
        out.addAll(right);
        return out;
    }

    private static Set<String> intersect(List<String> left, Set<String> right) {
        Set<String> out = new LinkedHashSet<>(left);
        out.retainAll(right);
        return out;
    }
}
