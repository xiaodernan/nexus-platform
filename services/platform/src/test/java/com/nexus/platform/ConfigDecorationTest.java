package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.testsupport.NexusIntegrationTest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * A key in {@code application.yml} is an offer to an operator: change this and the service behaves
 * differently. A key nothing reads is that offer withdrawn in silence — the operator sets it, the service
 * starts, and nothing happens. {@code nexus.idempotency.ttl-seconds} sat one step short of that until D46:
 * it was read, but the value only ever got written into a column that nothing compared with the clock, so
 * setting it to 60 and to 600000 behaved the same. {@code nexus.deletion.grace-days} is the case all the way
 * down — no code in this build reads it, because §106's retention job was never written.
 *
 * <p>So the gate walks the {@code nexus:} tree in the config files and asks one question per leaf: does any
 * {@code @Value} in {@code src/main/java} name it? Exceptions must carry a reason, and they must still be
 * unread and still be declared — an exemption left behind by a key that has since been wired up, or deleted,
 * is a comment about a file that no longer exists, which is how an allowlist rots.
 *
 * <p>The check runs in one direction on purpose. A declared key with no reader can only rot; a read key with
 * no declaration still works through its {@code @Value} default and its own comment, and several
 * ({@code nexus.llm.api-key}, {@code nexus.oauth.*}) are meant to arrive from the environment rather than
 * from a file in the repository.
 *
 * <p>{@link #profilesKeepTheEnvironmentInPlay} asks the same question of a second layer: a key can have a
 * reader and still be unreachable, because a profile sits above the base file and can quietly close the
 * {@code ${ENV:default}} offer it advertises.
 */
class ConfigDecorationTest extends NexusIntegrationTest {

    private static final Path RESOURCES = Path.of("src/main/resources");
    private static final Path MAIN = Path.of("src/main/java");
    private static final Pattern PROPERTY = Pattern.compile("\\$\\{(nexus\\.[A-Za-z0-9._-]+)");

    /** Declared but unread, and why that is honest rather than decorative. */
    private static final Map<String, String> UNREAD_BY_DESIGN = Map.of(
            "nexus.deletion.grace-days",
            "§106 queues a deletion instead of finishing it, and this build has no retention job — DELETE "
                    + "/api/v1/me erases PII immediately and writes the deletion_request row a future job would "
                    + "read. Wiring the grace period means scheduling irreversible data destruction, which is a "
                    + "human decision, not a default; docs/STATUS.md carries the same limitation.");

    @Test
    @DisplayName("Every nexus.* key the config offers is either read by code or exempted with a reason")
    void declaredKeysAreAnswered() throws IOException {
        List<Path> configs;
        try (var paths = Files.walk(RESOURCES)) {
            configs = paths.filter(p -> p.toString().endsWith(".yml")).sorted().toList();
        }
        Set<String> declared = new LinkedHashSet<>();
        for (Path config : configs) {
            declared.addAll(nexusLeaves(Files.readAllLines(config, StandardCharsets.UTF_8)).keySet());
        }
        assertThat(declared).as("the " + RESOURCES + " tree was parsed into leaves; a moved file must not "
                + "pass this gate by finding nothing").isNotEmpty();

        Set<String> read = new LinkedHashSet<>();
        try (var paths = Files.walk(MAIN)) {
            for (Path file : paths.filter(p -> p.toString().endsWith(".java")).toList()) {
                Matcher matcher = PROPERTY.matcher(Files.readString(file, StandardCharsets.UTF_8));
                while (matcher.find()) {
                    read.add(matcher.group(1));
                }
            }
        }
        assertThat(read).as("src/main/java names nexus.* properties at all").isNotEmpty();

        List<String> decorative = new ArrayList<>();
        for (String key : declared) {
            if (!read.contains(key) && !UNREAD_BY_DESIGN.containsKey(key)) {
                decorative.add(key + " (declared in " + RESOURCES + ", named by no @Value in " + MAIN + ")");
            }
        }
        assertThat(decorative).as("config an operator can set with no effect").isEmpty();

        List<String> stale = new ArrayList<>();
        for (Map.Entry<String, String> exemption : UNREAD_BY_DESIGN.entrySet()) {
            if (!declared.contains(exemption.getKey())) {
                stale.add(exemption.getKey() + " is exempted but no longer declared");
            } else if (read.contains(exemption.getKey())) {
                stale.add(exemption.getKey() + " is exempted but code reads it now — drop the exemption");
            }
            assertThat(exemption.getValue())
                    .as("an exemption with no reason is a TODO wearing a comment: " + exemption.getKey())
                    .isNotBlank();
        }
        assertThat(stale).as("exemptions that outlived what they excused").isEmpty();
    }

    /**
     * The second question a declared key can be asked: who else can still reach it. {@code application.yml}
     * offers {@code NEXUS_RL_AUTH}, {@code NEXUS_DEMO_LOGIN} and the rest by writing them as
     * {@code ${ENV:default}}; a profile that re-declares the same leaf as a bare literal outranks the base file
     * for that whole environment, so the operator's variable sets nothing and the file that mentions it never
     * says it has been overruled. D47 found this by asking a live dev instance what its login window was and
     * being told 100 while {@code application.yml} advertises 10.
     *
     * <p>Deliberate pinning is a legitimate thing a profile may have to do — but then it has to be written down
     * here with a reason, which is the rule {@link #UNREAD_BY_DESIGN} already enforces one level down. No leaf
     * needs that today, so there is no exemption list yet either.
     */
    @Test
    @DisplayName("A profile may not close an offer the base file makes")
    void profilesKeepTheEnvironmentInPlay() throws IOException {
        Map<String, String> base = nexusLeaves(
                Files.readAllLines(RESOURCES.resolve("application.yml"), StandardCharsets.UTF_8));
        assertThat(base).as("the base file parsed into nexus.* leaves; a moved file must not pass this gate by "
                + "finding nothing").isNotEmpty();

        List<String> closed = new ArrayList<>();
        int overlapping = 0;
        List<Path> profiles;
        try (var paths = Files.walk(RESOURCES)) {
            profiles = paths.filter(p -> p.getFileName().toString().matches("application-[A-Za-z0-9_-]+\\.yml"))
                    .sorted().toList();
        }
        for (Path profile : profiles) {
            for (Map.Entry<String, String> leaf : nexusLeaves(
                    Files.readAllLines(profile, StandardCharsets.UTF_8)).entrySet()) {
                String offered = base.get(leaf.getKey());
                if (offered == null || !offered.startsWith("${")) {
                    continue;   // the base file makes no environment offer on this leaf
                }
                overlapping++;
                if (!leaf.getValue().startsWith("${")) {
                    closed.add(profile + " pins " + leaf.getKey() + " to '" + leaf.getValue()
                            + "', which overrules the " + offered + " the base file offers");
                }
            }
        }
        assertThat(profiles).as("profile files exist under " + RESOURCES + " to be checked at all").isNotEmpty();
        assertThat(overlapping)
                .as("profiles re-declaring an env-backed base leaf — if this reaches 0 the gate is green "
                        + "because it stopped comparing anything, not because nothing is closed")
                .isPositive();
        assertThat(closed).as("settings an operator can export with no effect under a profile").isEmpty();
    }

    /**
     * Leaf paths under the top-level {@code nexus:} block, by indentation, mapped to the text after the colon:
     * a {@code key:} line with a value is a leaf, one without is a branch. No anchor, no flow mapping, no
     * multi-line scalar appears under {@code nexus:} in this build — if one is added, this parser has to be
     * taught before either gate is trusted.
     */
    private static Map<String, String> nexusLeaves(List<String> lines) {
        Map<String, String> leaves = new LinkedHashMap<>();
        LinkedHashMap<Integer, String> pathByIndent = new LinkedHashMap<>();
        boolean inside = false;
        for (String raw : lines) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            int indent = raw.length() - raw.stripLeading().length();
            if (indent == 0) {
                inside = line.equals("nexus:");
                pathByIndent.clear();
                continue;
            }
            if (!inside) {
                continue;
            }
            int separator = line.indexOf(':');
            if (separator < 0) {
                continue;
            }
            String name = line.substring(0, separator).strip();
            String value = line.substring(separator + 1).strip();
            Map.Entry<Integer, String> deepest = pathByIndent.lastEntry();
            while (deepest != null && deepest.getKey() >= indent) {
                pathByIndent.remove(deepest.getKey());
                deepest = pathByIndent.lastEntry();
            }
            pathByIndent.put(indent, name);
            if (!value.isEmpty()) {
                leaves.put("nexus." + String.join(".", pathByIndent.values()), value);
            }
        }
        return leaves;
    }
}
