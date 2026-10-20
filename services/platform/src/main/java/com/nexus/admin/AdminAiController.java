package com.nexus.admin;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPlatformRole;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * API_CONTRACT §9 — the admin AI observability reads ({@code /admin/ai/runs}, {@code /admin/ai/costs})
 * and the Admin Analytics Agent ({@code POST /admin/ai/ask}, §126).
 *
 * <p>Both halves are read-only, and that is the point of the file. {@code /runs} shows what the agents
 * actually did (status, tokens, cost, whether a fallback fired); {@code /costs} rolls the same rows up by
 * the three groupings §9 documents; {@code /ask} answers a question from <em>aggregate SQL over this
 * tenant's own rows</em> and nothing else.
 *
 * <p>§126 requires the agent's tools to be read-only, so {@code /ask} refuses an instruction to change
 * state (a leading mutating verb) with a 422 rather than quietly doing something. When no LLM key is
 * configured it does not invent a number and does not 500: it answers deterministically from SQL and says
 * so in {@code degraded} / {@code degraded_reason} / {@code answer_source}. The platform service ships no
 * LLM client at all, so the answer is SQL-backed in every configuration — the honest report, not a
 * fallback dressed up as a model.
 *
 * <p>Permission and audit are inherited from {@link RequiresPlatformRole} (the same interceptor
 * {@code ModerationController} uses): a consumer gets a 403 in the §1 envelope, an anonymous caller a 401,
 * and an allowed call writes {@code action='admin_access'}. Merchant staff have no route here.
 */
@RestController
@RequestMapping("/api/v1/admin/ai")
public class AdminAiController {

    private static final Set<String> GROUP_BY = Set.of("agent", "model", "day");
    private static final Set<String> RUN_STATUSES =
            Set.of("running", "succeeded", "failed", "fallback", "cancelled");

    /** A filter value is an identifier, never a fragment: anything else is a 422 before SQL sees it. */
    private static final Pattern AGENT_NAME = Pattern.compile("^[a-z][a-z0-9_]{0,63}$");

    /**
     * §126 read-only guard. The check is deliberately narrow — the <em>leading</em> verb, after an
     * optional courtesy prefix — so "how many orders were cancelled" stays a question while
     * "cancel order 5" is refused. It is a guard rail, not a parser; the endpoint cannot write in any
     * case, and this only stops a request whose intent is plainly a mutation from getting a cheerful
     * answer.
     */
    private static final Set<String> WRITE_VERBS = Set.of(
            "suspend", "unsuspend", "delete", "remove", "drop", "update", "create", "insert", "refund",
            "ban", "unban", "publish", "unpublish", "grant", "revoke", "wipe", "disable", "enable",
            "modify", "set", "cancel", "approve", "reject");
    private static final Pattern LEADING_VERB =
            Pattern.compile("^(?:(?:please|can|could|would|will|kindly)\\s+)*(?:you\\s+)?([a-z]+)");

    private static final int MAX_QUESTION = 500;

    private final AdminAiRepository ai;
    private final Paging paging;
    private final String llmKey;

    public AdminAiController(AdminAiRepository ai, Paging paging,
                             @Value("${nexus.llm.api-key:${NEXUS_LLM_API_KEY:}}") String llmKey) {
        this.ai = ai;
        this.paging = paging;
        this.llmKey = llmKey;
    }

    // ---------------------------------------------------------------- runs

    @GetMapping("/runs")
    @RequiresPlatformRole
    public Map<String, Object> runs(@RequestParam(required = false) String agent,
                                    @RequestParam(required = false) String status,
                                    @RequestParam(required = false) String limit,
                                    @RequestParam(required = false) String cursor,
                                    HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        String agentFilter = agent == null || agent.isBlank() ? null : identifier(agent, "agent");
        String statusFilter = status == null || status.isBlank() ? null
                : Paging.enumFilter(status, new ArrayList<>(RUN_STATUSES), "status");
        int size = paging.limit(limit);
        int offset = paging.offset(cursor);

        AdminAiRepository.Slice slice = ai.runs(tenant, agentFilter, statusFilter, size, offset);
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> row : slice.rows()) {
            items.add(runView(row));
        }
        Map<String, Object> page = paging.page(items, offset, size, slice.total());
        page.put("status", statusFilter == null ? "all" : statusFilter);
        page.put("as_of", Instant.now().toString());
        page.put("source", "agent_runs (DATABASE.md §3.12); one row per agent task, newest first, "
                + "tie-broken by id so a page boundary is stable");
        return page;
    }

    private static Map<String, Object> runView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("run_id", Json.str(row, "id"));
        out.put("agent", Json.str(row, "agent"));
        out.put("task_id", Json.str(row, "task_id"));
        out.put("model", Json.str(row, "model"));
        out.put("provider", Json.str(row, "provider"));
        out.put("status", Json.str(row, "status"));
        // §105: a fallback is the honest label for an answer the primary model did not give.
        out.put("fallback_used", Json.str(row, "fallback_used"));
        out.put("prompt_tokens", Json.longOf(row, "prompt_tokens"));
        out.put("completion_tokens", Json.longOf(row, "completion_tokens"));
        out.put("cost_usd", money(Json.dec(row, "cost_usd")));
        out.put("latency_ms", Json.integer(row, "latency_ms"));
        out.put("error", Json.str(row, "error"));
        out.put("merchant_id", Json.str(row, "merchant_id"));
        out.put("user_id", Json.str(row, "user_id"));
        out.put("conversation_id", Json.str(row, "conversation_id"));
        out.put("parent_run_id", Json.str(row, "parent_run_id"));
        out.put("fact_ids", Json.textArray(row, "fact_ids"));
        out.put("tool_calls", Json.jsonArray(row, "tool_calls"));
        out.put("started_at", Json.ts(row, "started_at"));
        out.put("finished_at", Json.ts(row, "finished_at"));
        return out;
    }

    // ---------------------------------------------------------------- costs

    @GetMapping("/costs")
    @RequiresPlatformRole
    public Map<String, Object> costs(@RequestParam(required = false) String group_by,
                                     @RequestParam(required = false) String limit,
                                     HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        String groupBy = groupBy(group_by);
        int size = paging.limit(limit);

        List<Map<String, Object>> groups = new ArrayList<>();
        for (Map<String, Object> row : ai.costBy(tenant, groupBy, size)) {
            Map<String, Object> group = new LinkedHashMap<>();
            group.put("key", Json.str(row, "group_key"));
            group.put("runs", Json.longOf(row, "runs"));
            group.put("cost_usd", money(Json.dec(row, "cost_usd")));
            group.put("prompt_tokens", Json.longOf(row, "prompt_tokens"));
            group.put("completion_tokens", Json.longOf(row, "completion_tokens"));
            group.put("avg_latency_ms", Json.longOf(row, "avg_latency_ms"));
            groups.add(group);
        }
        Map<String, Object> totalsRow = ai.costTotals(tenant);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("group_by", groupBy);
        out.put("groups", groups);
        out.put("totals", Json.map(
                "runs", Json.longOf(totalsRow, "runs"),
                "cost_usd", money(Json.dec(totalsRow, "cost_usd")),
                "prompt_tokens", Json.longOf(totalsRow, "prompt_tokens"),
                "completion_tokens", Json.longOf(totalsRow, "completion_tokens"),
                "agents", Json.longOf(totalsRow, "agents"),
                "models", Json.longOf(totalsRow, "models"),
                "fallback_runs", Json.longOf(totalsRow, "fallback_runs")));
        out.put("allowed_group_by", List.copyOf(GROUP_BY).stream().sorted().toList());
        out.put("as_of", Instant.now().toString());
        out.put("source", "agent_runs.cost_usd / *_tokens (DATABASE.md §3.12). llm_calls is finer-grained "
                + "but carries no tenant column, so the run-level roll-up is what this tenant-scoped read "
                + "reports; a per-call breakdown would need a join through agent_runs.");
        return out;
    }

    private static String groupBy(String raw) {
        String value = raw == null || raw.isBlank() ? "agent" : raw.trim().toLowerCase(Locale.ROOT);
        if (!GROUP_BY.contains(value)) {
            List<String> sorted = new ArrayList<>(GROUP_BY);
            sorted.sort(String::compareTo);
            throw ApiException.validation("group_by must be one of " + sorted,
                    Json.map("field", "group_by", "allowed", sorted, "received", raw));
        }
        return value;
    }

    // ---------------------------------------------------------------- ask (§126)

    public record AskBody(String question) {
    }

    @PostMapping("/ask")
    @RequiresPlatformRole
    public Map<String, Object> ask(@RequestBody(required = false) AskBody body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        String question = body == null || body.question() == null ? null : body.question().trim();
        if (question == null || question.isEmpty()) {
            throw ApiException.validation("question is required", Json.map("field", "question"));
        }
        if (question.length() > MAX_QUESTION) {
            throw ApiException.validation("question must be at most " + MAX_QUESTION + " characters",
                    Json.map("field", "question", "max_length", MAX_QUESTION, "received", question.length()));
        }
        String verb = leadingVerb(question);
        if (verb != null && WRITE_VERBS.contains(verb)) {
            // §126: the agent's tools are read-only. A request to change state is refused with the verb
            // named, never silently reinterpreted as a question and never half-performed.
            throw ApiException.validation("The admin analytics agent is read-only (§126); '" + verb
                            + "' is a write instruction and has no tool here",
                    Json.map("reason", "read_only", "refused_verb", verb, "field", "question"));
        }

        Map<String, Object> merchants = ai.merchantSnapshot(tenant);
        Map<String, Object> orders = ai.orderSnapshot(tenant);
        Map<String, Object> reservations = ai.reservationSnapshot(tenant);
        Map<String, Object> reviews = ai.reviewSnapshot(tenant);
        Map<String, Object> search = ai.searchEventSnapshot(tenant);
        Map<String, Object> runs = ai.costTotals(tenant);

        List<Map<String, Object>> evidence = new ArrayList<>();
        evidence.add(metric("merchants.total", Json.longOf(merchants, "total")));
        evidence.add(metric("merchants.published", Json.longOf(merchants, "published")));
        evidence.add(metric("merchants.suspended", Json.longOf(merchants, "suspended")));
        evidence.add(metric("orders.total", Json.longOf(orders, "total")));
        evidence.add(metric("orders.gmv", Json.dec(orders, "gmv")));
        evidence.add(metric("reservations.total", Json.longOf(reservations, "total")));
        evidence.add(metric("reviews.total", Json.longOf(reviews, "total")));
        evidence.add(metric("reviews.published", Json.longOf(reviews, "published")));
        evidence.add(metric("search.searches", Json.longOf(search, "searches")));
        evidence.add(metric("agent_runs.runs", Json.longOf(runs, "runs")));

        boolean keyConfigured = llmKey != null && !llmKey.isBlank();
        String answer = "This tenant has " + Json.longOf(merchants, "total") + " merchants ("
                + Json.longOf(merchants, "published") + " published, " + Json.longOf(merchants, "suspended")
                + " suspended), " + Json.longOf(orders, "total") + " orders (GMV "
                + money(Json.dec(orders, "gmv")) + "), " + Json.longOf(reservations, "total")
                + " reservations, " + Json.longOf(reviews, "total") + " reviews ("
                + Json.longOf(reviews, "published") + " published), and " + Json.longOf(search, "searches")
                + " search events. Agent runs: " + Json.longOf(runs, "runs") + ", cost USD "
                + money(Json.dec(runs, "cost_usd")) + ". Computed from aggregate SQL over this tenant's "
                + "own rows; no language model was called.";

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("question", question);
        out.put("answer", answer);
        out.put("answer_source", "sql");
        out.put("read_only", true);
        out.put("degraded", true);
        out.put("degraded_reason", keyConfigured
                ? "no_llm_client_in_platform_service"
                : "no_llm_key_configured");
        out.put("model_used", null);
        out.put("evidence", evidence);
        out.put("snapshot", Json.map(
                "merchants", merchants,
                "orders", orders,
                "reservations", reservations,
                "reviews", reviews,
                "search", search,
                "agent_runs", runs));
        out.put("as_of", Instant.now().toString());
        out.put("note", "§126: the admin analytics agent answers read-only questions from aggregate SQL. "
                + "It never writes, never exposes another merchant's rows, and states its degraded mode "
                + "instead of inventing a number.");
        return out;
    }

    /** The first real verb of the question, or null when the question starts with something else. */
    private static String leadingVerb(String question) {
        java.util.regex.Matcher m = LEADING_VERB.matcher(question.toLowerCase(Locale.ROOT));
        return m.find() ? m.group(1) : null;
    }

    private static Map<String, Object> metric(String name, Object value) {
        return Json.map("metric", name, "value", value);
    }

    private static String money(BigDecimal amount) {
        return amount == null ? null : amount.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString();
    }

    private static String identifier(String raw, String field) {
        String value = raw.trim().toLowerCase(Locale.ROOT);
        if (!AGENT_NAME.matcher(value).matches()) {
            throw ApiException.validation(field + " must be a lowercase identifier",
                    Json.map("field", field, "received", raw));
        }
        return value;
    }
}
