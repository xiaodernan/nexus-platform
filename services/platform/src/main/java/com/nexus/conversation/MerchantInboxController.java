package com.nexus.conversation;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The merchant inbox half of API_CONTRACT §5. Kept in {@code com.nexus.conversation} because the
 * thread/message/handoff model and its write-ownership rule belong to one module; the merchant
 * workspace package owns listings, offerings and members, not dialogue.
 *
 * <p>{@code send_message} is resolved by the {@code @RequiresPermission} interceptor against the
 * merchant id in the query parameter (list) or the conversation's own merchant (reply/resolve), so a
 * staff member of merchant A cannot read or answer merchant B's threads.
 */
@RestController
@RequestMapping("/api/v1/merchant/conversations")
public class MerchantInboxController {

    private final ConversationService conversations;
    private final Paging paging;

    public MerchantInboxController(ConversationService conversations, Paging paging) {
        this.conversations = conversations;
        this.paging = paging;
    }

    /** {@code GET /api/v1/merchant/conversations?merchant_id=&status=&limit=&cursor=}. */
    @GetMapping
    @RequiresPermission(value = "send_message", merchant = "param:merchant_id")
    public Map<String, Object> inbox(@RequestParam(required = false) String merchant_id,
                                     @RequestParam(required = false) String status,
                                     @RequestParam(required = false) String limit,
                                     @RequestParam(required = false) String cursor,
                                     HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = Json.uuidOrNull(merchant_id);
        if (merchantId == null) {
            throw ApiException.validation("Query parameter 'merchant_id' must be a uuid",
                    Json.map("field", "merchant_id"));
        }
        int size = paging.limit(limit);
        return conversations.merchantInbox(tenant, request, merchantId, status, size, paging.offset(cursor));
    }

    /** §5 alias of {@code POST /api/v1/conversations/{id}/reply}. */
    @PostMapping("/{id}/reply")
    @RequiresPermission(value = "send_message", merchant = "conversation:id")
    public Map<String, Object> reply(@PathVariable String id, @RequestBody Map<String, Object> body,
                                     HttpServletRequest request) {
        return conversations.merchantReply(Req.tenant(request), request, conversationUuid(id), body);
    }

    /** §5 alias of {@code POST /api/v1/conversations/{id}/handoff-resolve}. */
    @PostMapping("/{id}/handoff-resolve")
    @RequiresPermission(value = "send_message", merchant = "conversation:id")
    public Map<String, Object> resolve(@PathVariable String id,
                                       @RequestBody(required = false) Map<String, Object> body,
                                       HttpServletRequest request) {
        return conversations.resolveHandoff(Req.tenant(request), request, conversationUuid(id),
                body == null ? Map.of() : body);
    }

    private static UUID conversationUuid(String raw) {
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw ApiException.validation("Path parameter 'id' must be a uuid", Json.map("field", "id"));
        }
        return parsed;
    }
}
