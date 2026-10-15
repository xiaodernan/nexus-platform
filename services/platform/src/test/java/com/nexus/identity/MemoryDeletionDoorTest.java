package com.nexus.identity;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.nexus.platform.Json;
import com.nexus.testsupport.NexusIntegrationTest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.test.context.ActiveProfiles;

/**
 * The §106 memory door: {@code POST /api/v1/me/memory/reset}, and the kind vocabulary it completes.
 *
 * <p>Two documents disagreed and no route sat between them. {@code docs/CONSUMER.md} §8 has listed
 * <em>Delete memory</em> beside <em>Reset personalization</em> since the consumer doc was written, and the
 * ledger's own {@code kind} column names {@code memory} as one of the four acts it can record. What the build
 * had was the narrower door ({@code /me/personalization/reset}, keeps what the person typed) and the account
 * erase, and the erase — which D309 measured — is an {@code update users set …} plus the identity links: a
 * person who deleted their account kept every {@code user_preferences} row they had. So "delete memory" was a
 * control with no route, and the vocabulary member {@code memory} was a kind no door could file.
 * {@code docs/API_CONTRACT.md} §3 explains why nothing was built: a bulk wipe "would be indistinguishable, to
 * the person who just lost their quiet-venue memory, from a bug." That reason is answered rather than
 * overruled here — the wipe returns the count it took split by {@code source} and files a completed request
 * row carrying the same numbers, so the person can read, in their own export, that the act happened and which
 * rows it took.
 *
 * <p>These cases pin the door to that promise: every source label goes, other people's rows do not, other
 * tables do not, the filed row and the response cannot disagree, and the four-member vocabulary is walked
 * member by member — three of them through a live door, one of them named as still having none.
 */
@ActiveProfiles("test")
class MemoryDeletionDoorTest extends NexusIntegrationTest {

    /** The module's production sources, resolved the way Surefire runs the suite: cwd is {@code services/platform}. */
    private static final Path MAIN = Path.of("src/main/java");

    /** The migration that creates the ledger, read for the vocabulary its column comment declares. */
    private static final Path MIGRATION = Path.of("..", "..", "infra", "db", "migrations", "V1__init.sql");

    @Autowired
    IdentityRepository users;

    private record Person(Tenant tenant, UUID id, String token) {
    }

    /** One ledger row as the table holds it: the kind it says, its state, what it says it removed, and whether it says when. */
    private record Filed(String kind, String status, JsonNode payload, boolean hasCompletion) {
    }

    private static String tag() {
        return Long.toHexString(System.nanoTime());
    }

    private Person consumer(String label) {
        Tenant tenant = newTenant(label);
        UUID id = newUser(tenant, label + tag(), "consumer");
        return new Person(tenant, id, token(tenant, id, "consumer"));
    }

    private void plant(Person person, String key, String source) {
        jdbc.update("insert into user_preferences (user_id, kind, key, value, source) values (:u, 'food', :key,"
                        + " cast(:value as jsonb), :source)",
                new MapSqlParameterSource("u", person.id()).addValue("key", key)
                        .addValue("value", Json.write(Json.map("note", "preference " + key)))
                        .addValue("source", source));
    }

    private long preferences(Person person) {
        return count("select count(*) from user_preferences where user_id = :u", Map.of("u", person.id()));
    }

    private long requests(Person person, String kind) {
        return count("select count(*) from deletion_requests where user_id = :u and kind = :k",
                Map.of("u", person.id(), "k", kind));
    }

    /** Every kind this person's ledger holds, as the rows spell it — read, not asserted. */
    private Set<String> kindsFiled(Person person) {
        return new TreeSet<>(jdbc.queryForList("select kind from deletion_requests where user_id = :u",
                new MapSqlParameterSource("u", person.id()), String.class));
    }

    private Filed request(Person person, String kind) {
        assertThat(requests(person, kind)).as("exactly one %s row is expected before it is read", kind).isEqualTo(1);
        Map<String, Object> row = row("select d.kind, d.status, d.payload::text as payload, d.completed_at"
                        + " from deletion_requests d where d.user_id = :u and d.kind = :k",
                Map.of("u", person.id(), "k", kind));
        return new Filed((String) row.get("kind"), (String) row.get("status"),
                Json.tree(String.valueOf(row.get("payload"))), row.get("completed_at") != null);
    }

    private JsonNode wipe(Person person) {
        ResponseEntity<String> answer = post(person.tenant(), person.token(), "/api/v1/me/memory/reset", Json.map());
        assertThat(answer.getStatusCode())
                .as("the door must answer for a live account; it said: %s", answer.getBody()).isEqualTo(HttpStatus.OK);
        return Json.tree(answer.getBody());
    }

    private void resetPersonalization(Person person) {
        ResponseEntity<String> answer = post(person.tenant(), person.token(),
                "/api/v1/me/personalization/reset", Json.map());
        assertThat(answer.getStatusCode()).as("the narrower door must stay green; it said: %s", answer.getBody())
                .isEqualTo(HttpStatus.OK);
    }

    private void erase(Person person) {
        ResponseEntity<String> answer = exchange(HttpMethod.DELETE, person.tenant(), person.token(),
                "/api/v1/me", null);
        assertThat(answer.getStatusCode()).as("the erase door must stay green; it said: %s", answer.getBody())
                .isEqualTo(HttpStatus.OK);
    }

    /** §106's portability act: taking the file. It files a ledger row of its own, which the census below reads. */
    private void takeFile(Person person) {
        ResponseEntity<String> answer = get(person.tenant(), person.token(), "/api/v1/me/export");
        assertThat(answer.getStatusCode()).as("the export door must stay green; it said: %s", answer.getBody())
                .isEqualTo(HttpStatus.OK);
    }

    /** declared twice, inferred once, transaction once — one row for each label the column documents. */
    private void plantOneOfEachSource(Person person) {
        plant(person, "declared-a", "declared");
        plant(person, "declared-b", "declared");
        plant(person, "inferred-a", "inferred");
        plant(person, "transaction-a", "transaction");
    }

    @Test
    @DisplayName("The memory wipe takes every source the column can hold, and answers with the split it took")
    void theWipeTakesEverySourceLabelNotOnlyInferred() {
        Person person = consumer("memwipe");
        plantOneOfEachSource(person);
        assertThat(preferences(person)).as("four rows are planted, one per label twice over").isEqualTo(4);

        JsonNode answer = wipe(person);

        assertThat(answer.path("removed_preferences").asInt(-1))
                .as("the wipe is the whole memory, which is the only thing that separates it from the"
                        + " personalization reset").isEqualTo(4);
        assertThat(answer.path("removed_by_source").path("declared").asInt(-1))
                .as("what the person typed goes too — a door named for memory that left the declared rows"
                        + " behind would be the other door answering under this path").isEqualTo(2);
        assertThat(answer.path("removed_by_source").path("inferred").asInt(-1)).isEqualTo(1);
        assertThat(answer.path("removed_by_source").path("transaction").asInt(-1)).isEqualTo(1);
        assertThat(preferences(person)).as("and the table agrees with the answer it just printed")
                .isZero();
    }

    @Test
    @DisplayName("The personalization reset keeps what this wipe takes, and the two file two kinds")
    void theNarrowerDoorKeepsWhatThisOneTakes() {
        Person person = consumer("memboth");
        plantOneOfEachSource(person);

        resetPersonalization(person);
        assertThat(preferences(person)).as("the inferred row is the only one the narrow door takes").isEqualTo(3);

        JsonNode answer = wipe(person);
        assertThat(answer.path("removed_preferences").asInt(-1))
                .as("the wide door then takes the three that survived it").isEqualTo(3);
        assertThat(answer.path("removed_by_source").path("inferred").isMissingNode())
                .as("its split counts the rows this statement took, so a label already gone appears as absent,"
                        + " not as a zero the earlier door wrote").isTrue();
        assertThat(preferences(person)).as("and the memory is empty").isZero();

        assertThat(kindsFiled(person)).as("the two acts are two ledger rows, each under its own member of the"
                        + " declared vocabulary — one door may not file the other's kind")
                .containsExactlyInAnyOrder("memory", "personalization");
        assertThat(request(person, "memory").payload().path("removed_preferences").asInt(-1))
                .as("the memory row counts only the wipe").isEqualTo(3);
        assertThat(request(person, "personalization").payload().path("removed_inferred").asInt(-1))
                .as("and the personalization row counts only its own one").isEqualTo(1);
    }

    @Test
    @DisplayName("The filed memory row carries the response's own numbers, its state, and its completion moment")
    void theFiledRowCarriesTheNumbersTheResponseAnswered() {
        Person person = consumer("memfiled");
        plantOneOfEachSource(person);

        JsonNode answer = wipe(person);
        Filed filed = request(person, "memory");

        assertThat(filed.kind()).as("the row is filed under the member this door performs").isEqualTo("memory");
        assertThat(filed.status()).as("the platform did the deletion inside this request, so the row may not"
                + " read as one still waiting").isEqualTo("completed");
        assertThat(filed.hasCompletion()).as("and a completed status must carry the moment it claims").isTrue();
        assertThat(filed.payload().path("removed_preferences").asInt(-1))
                .as("the row and the reply answer with one number, not two copies that can drift: payload was %s,"
                        + " response was %s", filed.payload(), answer)
                .isEqualTo(answer.path("removed_preferences").asInt(-1));
        for (String source : List.of("declared", "inferred", "transaction")) {
            assertThat(filed.payload().path("by_source").path(source).asInt(-1))
                    .as("the same holds for each label of the split — the per-source counts the person was"
                            + " handed must be the counts the ledger kept for source %s", source)
                    .isEqualTo(answer.path("removed_by_source").path(source).asInt(-1));
        }
    }

    @Test
    @DisplayName("A wipe with nothing stored files its row with a zero, not nothing")
    void aWipeWithNothingStoredFilesItsRowWithZero() {
        Person person = consumer("memempty");

        JsonNode answer = wipe(person);

        assertThat(answer.path("removed_preferences").asInt(-1)).as("no preference row exists").isZero();
        assertThat(answer.path("removed_by_source").size())
                .as("and the split is an empty object, not a zero written for a label nothing carried")
                .isZero();
        assertThat(requests(person, "memory"))
                .as("the request is filed because the person made it, not because it happened to delete rows"
                        + " — a ledger that records only non-empty outcomes cannot tell a no-op apart from a"
                        + " door nobody called").isEqualTo(1);
        assertThat(request(person, "memory").payload().path("removed_preferences").asInt(-1))
                .as("and the row records the zero").isZero();
    }

    @Test
    @DisplayName("The wipe reaches the caller's rows and nobody else's, in the same tenant or another")
    void theWipeIsScopedToTheCallerAlone() {
        Person caller = consumer("memscope");
        Person neighbour = consumer("memscope");
        Person elsewhere = consumer("memscopeother");
        plant(caller, "mine-a", "declared");
        plant(caller, "mine-b", "inferred");
        plant(neighbour, "theirs", "declared");
        plant(elsewhere, "elsewhere", "declared");

        wipe(caller);

        assertThat(preferences(caller)).as("the caller's two rows are gone").isZero();
        assertThat(preferences(neighbour)).as("a second person in the caller's own tenant is not part of the"
                + " caller's memory, and the users join must not be the only thing deciding whose rows go")
                .isEqualTo(1);
        assertThat(preferences(elsewhere)).as("and a person in another tenant is invisible to this door").isEqualTo(1);
    }

    @Test
    @DisplayName("The wipe takes the memory and leaves the rest of the person's rows where they are")
    void theWipeTakesPreferenceRowsAndNothingElse() {
        Person person = consumer("memscope2");
        plant(person, "keep-1", "declared");
        plant(person, "keep-2", "transaction");
        jdbc.update("insert into favorites (user_id, subject_type, subject_id) values (:u, 'merchant', :s)",
                new MapSqlParameterSource("u", person.id()).addValue("s", UUID.randomUUID()));
        jdbc.update("insert into saved_searches (user_id, name, query) values (:u, 'quiet', 'tea')"
                        + " on conflict do nothing",
                new MapSqlParameterSource("u", person.id()));

        JsonNode answer = wipe(person);

        assertThat(preferences(person)).as("the preference table is the whole of this door's reach").isZero();
        assertThat(answer.path("scope").asText())
                .as("and the response prints that boundary, because the word memory in a privacy control"
                        + " invites the reading that everything personal is gone").isEqualTo("user_preferences_rows");
        assertThat(count("select count(*) from favorites where user_id = :u", Map.of("u", person.id())))
                .as("a favourite is a saved item, not a learned preference").isEqualTo(1);
        assertThat(count("select count(*) from saved_searches where user_id = :u", Map.of("u", person.id())))
                .as("and a saved search survives the memory wipe").isEqualTo(1);
        assertThat(get(person.tenant(), person.token(), "/api/v1/me").getStatusCode())
                .as("the account itself is untouched — that is DELETE /api/v1/me, a different act with a"
                        + " different kind").isEqualTo(HttpStatus.OK);
        assertThat(get(person.tenant(), person.token(), "/api/v1/me/preferences").getBody())
                .as("the person can still read their (now empty) memory through the same door as before")
                .isEqualTo("[]");
    }

    @Test
    @DisplayName("The person's own export shows the memory wipe they made, with its completion moment")
    void theExportShowsTheWipeThatFiledIt() {
        Person person = consumer("memexport");
        plant(person, "x-inferred", "inferred");
        plant(person, "x-declared", "declared");

        JsonNode answer = wipe(person);

        ResponseEntity<String> file = get(person.tenant(), person.token(), "/api/v1/me/export");
        assertThat(file.getStatusCode()).as("the file is readable because the wipe is not an erasure; it said: %s",
                file.getBody()).isEqualTo(HttpStatus.OK);
        JsonNode rows = Json.tree(file.getBody()).path("deletion_requests");
        assertThat(rows.size()).as("one act, one row in the person's own file").isEqualTo(1);
        JsonNode row = rows.get(0);
        assertThat(row.path("kind").asText()).isEqualTo("memory");
        assertThat(row.path("status").asText()).isEqualTo("completed");
        assertThat(row.path("completed_at").isNull())
                .as("a completed row the person can read must show the moment its status claims: %s", row).isFalse();
        assertThat(row.path("payload").path("removed_preferences").asInt(-1))
                .as("the file publishes the row's own count, which is the number the door answered with")
                .isEqualTo(answer.path("removed_preferences").asInt(-1));
    }

    /**
     * The vocabulary walked member by member, by two readers of different material. One reader calls the doors
     * and asks the table which kinds exist afterwards; the other opens the production sources and asks which
     * {@code DeletionKind} constants appear in a {@code createDeletionRequest} call. The two must agree — a kind
     * filed by a repository seam nobody can reach over HTTP, or a door whose row the source census missed,
     * reddens one reader and not the other. D333 left one member of the four with no door at all and printed it
     * by name; this build files it, so the residue the case demands is now empty and a member added to the
     * column comment without a route reddens the census again rather than surviving as prose.
     */
    @Test
    @DisplayName("The kind vocabulary is the migration's own list and every member has a door behind it")
    void theDeclaredVocabularyIsWalkedDoorByDoor() throws Exception {
        Set<String> declared = Arrays.stream(IdentityRepository.DeletionKind.values())
                .map(IdentityRepository.DeletionKind::kind).collect(java.util.stream.Collectors.toCollection(TreeSet::new));
        assertThat(declared).as("the enum is the census this file walks, so its members are the claim").hasSize(4);
        assertThat(ddlKindVocabulary()).as("the enum's texts are the vocabulary the column's own comment"
                        + " declares — a fifth spelling added to the migration without a door here reddens this"
                        + " claim rather than living only in a comment")
                .containsExactlyInAnyOrderElementsOf(declared);

        // Reader one, through the doors: one person per act, then what the ledger holds for each.
        Person account = consumer("memkindacct");
        Person memory = consumer("memkindmem");
        Person personalization = consumer("memkindpers");
        Person exporter = consumer("memkindexport");
        erase(account);
        wipe(memory);
        plant(personalization, "p-inferred", "inferred");
        resetPersonalization(personalization);
        takeFile(exporter);
        Set<String> byDoors = new TreeSet<>();
        for (Person person : List.of(account, memory, personalization, exporter)) {
            Set<String> kinds = kindsFiled(person);
            assertThat(kinds).as("each door files exactly one kind, its own — a door that wrote two rows would"
                    + " make the ledger say more than the act did").hasSize(1);
            byDoors.addAll(kinds);
        }
        assertThat(byDoors).as("the four live doors, read off the table").containsExactlyInAnyOrder(
                "account", "export", "memory", "personalization");

        // Reader two, through the production source.
        List<String> arguments = filingArguments();
        Set<String> bySource = new TreeSet<>();
        for (String argument : arguments) {
            for (String member : kindsNamedIn(argument)) {
                // The source names a member, the row holds its text, and the enum is the only thing that ties
                // the two: translated here rather than compared spelling-by-spelling, so a member whose declared
                // text no door can file still reddens this claim.
                bySource.add(IdentityRepository.DeletionKind.valueOf(member).kind());
            }
        }
        assertThat(arguments).as("the census reads real call sites; an empty reader would agree with anything")
                .hasSizeGreaterThanOrEqualTo(declared.size());
        assertThat(bySource).as("the two readers are made of different material and must not disagree about"
                        + " which kinds this build files — the source names %s, the doors filed %s",
                        bySource, byDoors)
                .containsExactlyInAnyOrderElementsOf(byDoors);

        Set<String> withoutDoors = new TreeSet<>(declared);
        withoutDoors.removeAll(byDoors);
        assertThat(withoutDoors)
                .as("every member the column comment declares is filed by a door this build runs, so the residue"
                        + " is empty: a member that appears here names a route nobody built, which is exactly what"
                        + " D333 left behind for the export request and this unit closed")
                .isEmpty();
    }

    @Test
    @DisplayName("The source reader is proven on planted calls before its verdict on the tree means anything")
    void theFilingArgumentReaderNamesWhatItClaims() {
        String qualified = "users.createDeletionRequest(tenant, userId, IdentityRepository.DeletionKind.MEMORY,"
                + " IdentityRepository.DeletionState.COMPLETED, Json.map(\"removed_preferences\", taken.total()))";
        assertThat(argumentsOf(qualified, "createDeletionRequest")).as("one call, balanced across its nested"
                + " Json.map parentheses").hasSize(1);
        assertThat(kindsNamedIn(argumentsOf(qualified, "createDeletionRequest").get(0)))
                .as("the qualified constant is read as the member it names").containsExactly("MEMORY");

        String split = "users.createDeletionRequest(tenant, userId,\n"
                + "        IdentityRepository.DeletionKind.EXPORT, state, Json.map());";
        assertThat(kindsNamedIn(argumentsOf(split, "createDeletionRequest").get(0)))
                .as("a call written across lines is one argument list, not two fragments").containsExactly("EXPORT");

        String declaration = "public UUID createDeletionRequest(TenantContext tenant, UUID userId,"
                + " DeletionKind kind, DeletionState state, Map<String, Object> payload) {";
        assertThat(kindsNamedIn(argumentsOf(declaration, "createDeletionRequest").get(0)))
                .as("the declaration's own parameter list names the type, not a member, and must not be"
                        + " counted as a filing site").isEmpty();

        String none = "otherService.record(tenant, userId);";
        assertThat(argumentsOf(none, "createDeletionRequest")).as("a tree with no call yields no site rather"
                + " than an empty match that reads as one").isEmpty();
    }

    // ---------------------------------------------------------------- source census plumbing

    /** The vocabulary the {@code kind} column's own comment declares, out of the migration that creates it. */
    private List<String> ddlKindVocabulary() throws java.io.IOException {
        assertThat(MIGRATION).as("the ledger's declared vocabulary is read from the migration that creates the"
                + " table, not copied into this file").exists();
        String text = Files.readString(MIGRATION, StandardCharsets.UTF_8);
        String block = argumentsOf(text, "CREATE TABLE deletion_requests").stream()
                .findFirst().orElseThrow(() -> new AssertionError("the migration's own table body is what this"
                        + " census reads; it was not found"));
        Matcher m = Pattern.compile("kind\\s+text[^\\n]*--\\s*([A-Za-z_|]+)").matcher(block);
        assertThat(m.find()).as("the `kind` column carries the vocabulary as a comment, and this census reads"
                + " it there rather than asserting a list beside it").isTrue();
        return List.of(m.group(1).split("\\|"));
    }

    /** Every {@code createDeletionRequest} argument list in the module's production sources. */
    private List<String> filingArguments() throws java.io.IOException {
        assertThat(MAIN).as("the census reads the production sources from the module the suite runs in")
                .isDirectory();
        List<Path> files;
        try (var paths = Files.walk(MAIN)) {
            files = paths.filter(p -> p.toString().endsWith(".java")).sorted().toList();
        }
        assertThat(files).as("the walk found the module's own production sources").isNotEmpty();
        List<String> out = new ArrayList<>();
        for (Path file : files) {
            out.addAll(argumentsOf(Files.readString(file, StandardCharsets.UTF_8), "createDeletionRequest"));
        }
        return out;
    }

    private static List<String> kindsNamedIn(String arguments) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("DeletionKind\\.([A-Z_]+)").matcher(arguments);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    /**
     * The text inside the parentheses each {@code method} opens, matched by depth rather than by the first
     * closing bracket — a call whose arguments contain {@code Json.map(...)} ends two brackets later than a
     * first-bracket reader thinks, and a truncated argument list silently stops naming kinds. The primitive is
     * shared with {@link #ddlKindVocabulary()} for the same reason, and proven on planted calls above.
     *
     * <p>What it cannot see is a call whose arguments contain an unbalanced bracket inside a string literal;
     * production has no such call at the parent, and this census claims only what it walks.
     */
    private static List<String> argumentsOf(String text, String method) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("\\b" + Pattern.quote(method) + "\\s*\\(").matcher(text);
        while (m.find()) {
            int open = m.end() - 1;
            int depth = 0;
            for (int i = open; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c == '(') {
                    depth++;
                } else if (c == ')') {
                    depth--;
                    if (depth == 0) {
                        out.add(text.substring(open + 1, i));
                        break;
                    }
                }
            }
            assertThat(depth).as("%s opens a parenthesis this file never closes", method).isZero();
        }
        return out;
    }
}
