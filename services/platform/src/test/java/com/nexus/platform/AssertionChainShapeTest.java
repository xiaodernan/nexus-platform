package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * An AssertJ chain decides something only at its end: {@code assertThat(x)} hands back an object and
 * {@code .as("…")} hands back the same object with a nicer message attached. {@code isTrue}, {@code isEqualTo},
 * {@code hasSize} — those assert. A chain that stops at a describer is therefore not a weak test, it is no test:
 * it is green under every possible source, and it looks exactly like the gate it replaced.
 *
 * <p>D61 paid for this twice. Mutation M7 deletes {@code @RequiresAuth} from §8's draft door; the refusal that
 * survives it comes from {@code Req.userId} one line later, with the same code and message, so no HTTP assertion
 * can see the difference. The fix asked the method reflectively — and stayed green through the next mutation run,
 * because the check was written {@code assertThat(m.isAnnotationPresent(RequiresAuth.class)).as("%s is §8's only
 * write", name)} inside a stream {@code peek}. Nothing was asserted. A gate whose every failure mode is silence is
 * the worst kind of evidence, so the shape is refused here rather than remembered.
 *
 * <p>The reader works on a comment- and literal-masked copy of each file (a {@code //} note or a {@code "} string
 * can hold anything, including a bracket), and it is checked against planted cases in {@link #readerSeesWhatItClaims()}
 * before its verdict on the tree means anything. What it cannot see is a chain that reaches a terminal and picks
 * the wrong one — that is a different bug, and this file does not claim otherwise.
 */
class AssertionChainShapeTest {

    private static final Path TESTS = Path.of("src/test/java");

    /** The entry points this codebase uses, plus the two spellings it would use tomorrow. */
    private static final List<String> ENTRIES =
            List.of("assertThat(", "assertThatThrownBy(", "assertThatCode(", "assertThatExceptionOfType(");

    /** Calls that decorate a chain without deciding anything. */
    private static final Set<String> NOT_TERMINALS =
            Set.of("as", "describedAs", "withFailMessage", "because", "over");

    @Test
    @DisplayName("Every assertion in this module's tests reaches a terminal call")
    void noTestStopsShortOfADecision() throws IOException {
        assertThat(TESTS).as("the gate reads the tests from the source tree, not from a list").isDirectory();
        List<Path> files;
        try (var paths = Files.walk(TESTS)) {
            files = paths.filter(p -> p.toString().endsWith(".java")).sorted().toList();
        }
        assertThat(files).as("the walk found the module's own test sources").isNotEmpty();

        List<String> vacuous = new ArrayList<>();
        int entries = 0;
        for (Path file : files) {
            String masked = mask(Files.readString(file, StandardCharsets.UTF_8));
            entries += countEntries(masked);
            for (String hit : vacuousChains(masked)) {
                vacuous.add(file + ":" + hit);
            }
        }
        // A reader that finds nothing anywhere is indistinguishable from a reader that is broken, so the census
        // has to be non-zero for the empty verdict above to mean anything.
        assertThat(entries).as("%d test files scanned: the reader must be looking at real entry points", files.size())
                .isGreaterThan(1000);
        assertThat(vacuous).as("assertion chains that never reach a terminal").isEmpty();
    }

    @Test
    @DisplayName("The reader names the shape it claims to name, and only that")
    void readerSeesWhatItClaims() {
        String bad = "void a() { assertThat(x.isY()).as(\"the door\"); }";
        String good = "void b() { assertThat(x.isY()).as(\"the door\").isTrue(); }";
        assertThat(vacuousChains(mask(bad))).as("a chain ending at as()").hasSize(1);
        assertThat(vacuousChains(mask(good))).as("the same chain with the verdict").isEmpty();

        assertThat(vacuousChains(mask("void c() { assertThat(x); }"))).as("no chain at all").hasSize(1);
        assertThat(vacuousChains(mask("void d() { assertThat(m.get(\"k)\"))\n        .describedAs(\"a ) in a string\"); }")))
                .as("a bracket inside a literal must not end the scan early").hasSize(1);
        assertThat(vacuousChains(mask("void e() { assertThatThrownBy(() -> s.go()).because(\"why\"); }")))
                .as("because() decorates too").hasSize(1);
        assertThat(vacuousChains(mask("void f() { Assertions.assertThat(s.list()).containsExactly(\"a\"); }")))
                .as("a qualified entry point is still an entry point").isEmpty();
        assertThat(vacuousChains(mask("void g() { helper.assertThat(s.list()); }")))
                .as("someone else's method of the same name is not").isEmpty();
        assertThat(vacuousChains(mask("void h() { // assertThat(x).as(\"commented out\");\n  assertThat(y).isZero(); }")))
                .as("a commented-out chain is not a chain").isEmpty();
        assertThat(vacuousChains(mask("void i() { assertThat(t.block()).satisfies(v -> {\n  assertThat(v).isEqualTo(1);\n}); }")))
                .as("a nested chain that does decide").isEmpty();
        assertThat(vacuousChains(mask("void j() { assertThat(TEXT.\"\"\"\n  a ) { [ unbalanced\n  \"\"\".formatted()).isNotNull(); }")))
                .as("a text block holding brackets").isEmpty();
    }

    /** One description per entry point whose chain contains no call other than a describer. */
    private static List<String> vacuousChains(String maskedSource) {
        List<String> hits = new ArrayList<>();
        for (int i = 0; i < maskedSource.length(); i++) {
            String entry = entryAt(maskedSource, i);
            if (entry == null || !isEntryPoint(maskedSource, i)) {
                continue;
            }
            List<String> calls = chainCalls(maskedSource, matchParen(maskedSource, i + entry.length() - 1));
            if (calls.stream().allMatch(NOT_TERMINALS::contains)) {
                hits.add("%d: chain=%s".formatted(lineOf(maskedSource, i), calls));
            }
        }
        return hits;
    }

    private static int countEntries(String masked) {
        int n = 0;
        for (int i = 0; i < masked.length(); i++) {
            if (entryAt(masked, i) != null && isEntryPoint(masked, i)) {
                n++;
            }
        }
        return n;
    }

    /**
     * The entry point whose text begins here, or null. No entry is a prefix of another — each carries its own
     * opening bracket — so the first match is the only match.
     */
    private static String entryAt(String source, int at) {
        for (String entry : ENTRIES) {
            if (source.startsWith(entry, at)) {
                return entry;
            }
        }
        return null;
    }

    /**
     * {@code foo.assertThat(x)} is somebody else's method, and {@code Assertions.assertThat(x)} is ours. The
     * qualifier decides, so the mask keeps the identifiers and only blanks the bodies of comments and literals.
     */
    private static boolean isEntryPoint(String source, int at) {
        int prev = skipBack(source, at);
        if (prev < 0 || source.charAt(prev) != '.') {
            return prev < 0 || !Character.isLetterOrDigit(source.charAt(prev)) && source.charAt(prev) != '_';
        }
        int end = prev;
        int start = end;
        while (start > 0 && Character.isJavaIdentifierPart(source.charAt(start - 1))) {
            start--;
        }
        return "Assertions".equals(source.substring(start, end));
    }

    private static int skipBack(String source, int at) {
        int i = at - 1;
        while (i >= 0 && Character.isWhitespace(source.charAt(i))) {
            i--;
        }
        return i;
    }

    /** The {@code .name(…)} groups following an expression, as far as they go. */
    private static List<String> chainCalls(String source, int from) {
        List<String> calls = new ArrayList<>();
        int i = from;
        while (true) {
            i = skipWs(source, i);
            if (i >= source.length() || source.charAt(i) != '.') {
                return calls;
            }
            i = skipWs(source, i + 1);
            int start = i;
            while (i < source.length() && Character.isJavaIdentifierPart(source.charAt(i))) {
                i++;
            }
            if (i == start) {
                return calls;
            }
            calls.add(source.substring(start, i));
            i = skipWs(source, i);
            if (i >= source.length() || source.charAt(i) != '(') {
                return calls;
            }
            i = matchParen(source, i);
        }
    }

    /** Index just past the {@code )} matching the {@code (} at {@code open}. The input is already masked. */
    private static int matchParen(String source, int open) {
        int depth = 0;
        for (int i = open; i < source.length(); i++) {
            char c = source.charAt(i);
            if (c == '(') {
                depth++;
            } else if (c == ')') {
                depth--;
                if (depth == 0) {
                    return i + 1;
                }
            }
        }
        return source.length();
    }

    /**
     * Blank out comment and literal *bodies*, keeping every character position, every newline, and every
     * delimiter that matters to the reader above. After this, brackets cannot lie about where an expression ends.
     */
    private static String mask(String source) {
        char[] out = source.toCharArray();
        int i = 0;
        while (i < out.length) {
            char c = out[i];
            if (c == '/' && i + 1 < out.length && out[i + 1] == '/') {
                int end = source.indexOf('\n', i);
                i = blankTo(out, i, end < 0 ? out.length : end);
            } else if (c == '/' && i + 1 < out.length && out[i + 1] == '*') {
                int end = source.indexOf("*/", i + 2);
                i = blankTo(out, i, end < 0 ? out.length : end + 2);
            } else if (c == '"' && source.startsWith("\"\"\"", i)) {
                int end = source.indexOf("\"\"\"", i + 3);
                i = blankTo(out, i, end < 0 ? out.length : end + 3);
            } else if (c == '"' || c == '\'') {
                i = blankLiteral(out, c, i);
            } else {
                i++;
            }
        }
        return new String(out);
    }

    /** Blank up to and including {@code stop}; a delimiter at the very end of the span survives. */
    private static int blankTo(char[] out, int from, int stop) {
        for (int i = from; i < stop && i < out.length; i++) {
            if (out[i] != '\n') {
                out[i] = ' ';
            }
        }
        return stop;
    }

    /** One string or char literal, escapes honoured: {@code "\""} is a quote, not the end of the literal. */
    private static int blankLiteral(char[] out, char quote, int from) {
        int i = from + 1;
        while (i < out.length) {
            if (out[i] == '\\' && i + 1 < out.length) {
                out[i + 1] = ' ';
                i += 2;
                continue;
            }
            if (out[i] == quote) {
                return i + 1;
            }
            if (out[i] != '\n') {
                out[i] = ' ';
            }
            i++;
        }
        return i;
    }

    private static int skipWs(String source, int i) {
        while (i < source.length() && Character.isWhitespace(source.charAt(i))) {
            i++;
        }
        return i;
    }

    private static int lineOf(String source, int at) {
        int line = 1;
        for (int i = 0; i < at && i < source.length(); i++) {
            if (source.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }
}
