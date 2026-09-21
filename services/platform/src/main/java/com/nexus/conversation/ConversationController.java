package com.nexus.conversation;

import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Consumer-side conversation routes (API_CONTRACT §3) and the two human merchant writes the lead
 * assigned to this module (STATUS.md D12 items b/c/d).
 *
 * <p>Write ownership is documented in {@code conversation/README.md}: the AI service is the only
 * writer of agent-path rows, and it writes through
 * {@code POST /api/v1/internal/conversations/{id}/agent-message} behind a service token rather than
 * owning the table.
 *
 * <p>Note on paths: §3 also lists {@code GET /api/v1/me/conversations}. The equivalent here is
 * {@code GET /api/v1/conversations}, which returns exactly the caller's own threads; the {@code /me/*}
 * namespace belongs to the identity stream, and registering the same mapping twice would stop the
 * application from booting. See the README "Route notes".
 */
@RestController
@RequestMapping("/api/v1")
public class ConversationController {

    private static final Logger log = LoggerFactory.getLogger(ConversationController.class);

    private final ConversationService conversations;
    private final AiServiceTokenGuard internalGuard;
    private final Paging paging;

    public ConversationController(ConversationService conversations, AiServiceTokenGuard internalGuard,
                                  Paging paging) {
        this.conversations = conversations;
        this.internalGuard = internalGuard;
        this.paging = paging;
    }

    /** (b) {@code POST /api/v1/conversations {merchant_id?, channel, mode}} → the opened thread. */
    @PostMapping("/conversations")
    @RequiresAuth
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> open(@RequestBody(required = false) Map<String, Object> body,
                                    HttpServletRequest request) {
        return conversations.open(Req.tenant(request), request, body == null ? Map.of() : body);
    }

    /** {@code GET /api/v1/conversations/{id}} — thread + messages + handoffs. Owner / staff / admin. */
    @GetMapping("/conversations/{id}")
    @RequiresAuth
    public Map<String, Object> thread(@PathVariable String id,
                                      @RequestParam(required = false) String limit,
                                      @RequestParam(required = false) String cursor,
                                      HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        int size = paging.limit(limit);
        return conversations.thread(tenant, request, uuidOr422(id), size, paging.offset(cursor));
    }

    /** The caller's own threads. Same pagination envelope as §1. */
    @GetMapping("/conversations")
    @RequiresAuth
    public Map<String, Object> mine(@RequestParam(required = false) String limit,
                                    @RequestParam(required = false) String cursor,
                                    HttpServletRequest request) {
        int size = paging.limit(limit);
        return conversations.myThreads(Req.tenant(request), request, size, paging.offset(cursor));
    }

    /** (c) human {@code merchant_user} reply. RBAC: {@code send_message} on the thread's merchant. */
    @PostMapping("/conversations/{id}/reply")
    @RequiresPermission(value = "send_message", merchant = "conversation:id")
    public Map<String, Object> reply(@PathVariable String id, @RequestBody Map<String, Object> body,
                                     HttpServletRequest request) {
        return conversations.merchantReply(Req.tenant(request), request, uuidOr422(id), body);
    }

    /** (d) close out a handoff the merchant team has taken over. */
    @PostMapping("/conversations/{id}/handoff-resolve")
    @RequiresPermission(value = "send_message", merchant = "conversation:id")
    public Map<String, Object> resolve(@PathVariable String id,
                                       @RequestBody(required = false) Map<String, Object> body,
                                       HttpServletRequest request) {
        return conversations.resolveHandoff(Req.tenant(request), request, uuidOr422(id),
                body == null ? Map.of() : body);
    }

    /**
     * (e) the AI service's single audited write door. Guarded by the shared service token, not by a
     * user JWT: {@code X-Internal-Token}. Tenant still comes from {@code X-Tenant}, so an agent write
     * can never land in another market's thread.
     */
    @PostMapping("/internal/conversations/{id}/agent-message")
    public Map<String, Object> agentMessage(@PathVariable String id,
                                            @RequestHeader(value = AiServiceTokenGuard.HEADER, required = false)
                                            String token,
                                            @RequestBody Map<String, Object> body,
                                            HttpServletRequest request) {
        internalGuard.require(token);
        TenantContext tenant = Req.tenant(request);
        log.info("internal_agent_message tenant={} conversation_id={} agent_run_id={}", tenant.idString(), id,
                body.get("agent_run_id"));
        return conversations.agentMessage(tenant, request, uuidOr422(id), body);
    }

    private static UUID uuidOr422(String raw) {
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw com.nexus.platform.ApiException.validation("Path parameter 'id' must be a uuid",
                    Json.map("field", "id"));
        }
        return parsed;
    }
}
