package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.nexus.testsupport.NexusIntegrationTest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;

/**
 * D56 was the suite discovering its own ceiling: adding two property-overriding test classes pushed the run past
 * the container's {@code max_connections} and seven tests errored with "remaining connection slots are reserved
 * for roles with the SUPERUSER attribute". Every distinct {@code @SpringBootTest} property set is a separate
 * cached context, and every context holds its own Hikari pool, so a new witness class is not free — it costs
 * {@code pool size} connections for the rest of the run. Nothing counted that, and a budget nobody measures is
 * spent silently until it is gone.
 *
 * <p>This class deliberately adds no context of its own — no property overrides, so it joins the shared one — and
 * asks two things that can each go red. The pool size the running service actually bound has to be the pinned
 * small one, and {@code contexts × pool} has to stay inside the container's own {@code max_connections}, read
 * from the database at runtime rather than copied into a comment where it would go stale.
 */
class TestConnectionBudgetTest extends NexusIntegrationTest {

    private static final Path TESTS = Path.of("src/test/java");
    private static final int PINNED_POOL_SIZE = 5;

    @Autowired
    Environment env;

    @Test
    @DisplayName("Every cached context times its pool still fits inside the container's connections")
    void contextBudgetFitsTheContainer() throws IOException {
        List<String> ownContext = new ArrayList<>();
        boolean sharedExists = false;
        List<Path> files;
        try (var paths = Files.walk(TESTS)) {
            files = paths.filter(p -> p.getFileName().toString().endsWith("Test.java")).sorted().toList();
        }
        for (Path file : files) {
            String text = Files.readString(file, StandardCharsets.UTF_8);
            if (!text.contains("NexusIntegrationTest") && !text.contains("@SpringBootTest")) {
                continue;   // a plain unit test costs no context and no connection
            }
            if (text.contains("@TestPropertySource") || text.contains("@ActiveProfiles")
                    || text.contains("@MockitoBean") || text.contains("@MockBean")) {
                ownContext.add(TESTS.relativize(file).toString());
            } else {
                sharedExists = true;
            }
        }

        int contexts = ownContext.size() + (sharedExists ? 1 : 0);
        int pool = env.getProperty("spring.datasource.hikari.maximum-pool-size", Integer.class);
        int maxConnections = (int) count("select current_setting('max_connections')::int as n", Map.of());

        assertThat(maxConnections)
                .as("the container answered, so the ceiling is measured and not remembered")
                .isPositive();
        assertThat(ownContext).as("the classes that each cost a context of their own").isNotEmpty();

        // Order matters: the budget is asserted first, so a raised pool fails for the reason that matters —
        // contexts multiply it — and the pin below is only the tie between this file and the harness.
        int allowance = (maxConnections - 1) / contexts;
        assertThat(pool)
                .as("%d cached contexts against a container allowing %d connections: no context may hold more "
                                + "than %d. Each @TestPropertySource or @ActiveProfiles class above is one more "
                                + "context, so a new one costs room whether or not the pool changes.",
                        contexts, maxConnections, allowance)
                .isLessThanOrEqualTo(allowance);
        assertThat(pool)
                .as("the value the harness pins, tied here so the budget above cannot be quietly redefined by "
                        + "editing one of the two")
                .isEqualTo(PINNED_POOL_SIZE);
        assertThat(contexts * pool)
                .as("%d contexts × %d connections each, inside a container that allows %d (classes taking a "
                                + "context of their own: %s)",
                        contexts, pool, maxConnections, ownContext)
                .isLessThan(maxConnections);
    }
}
