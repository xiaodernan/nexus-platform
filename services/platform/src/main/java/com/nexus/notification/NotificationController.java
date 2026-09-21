package com.nexus.notification;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * In-app notification inbox (§123-125, API_CONTRACT §3).
 *
 * <p>Every route is scoped to the authenticated subject taken from the verified token — there is no
 * {@code ?user_id=} parameter anywhere, so one caller can never enumerate another's inbox. A
 * notification the subject cannot see reads as {@code 404 notification_not_found}, never 403 (D5).
 */
@RestController
@RequestMapping("/api/v1/notifications")
@RequiresAuth
public class NotificationController {

    private final NotificationService notifications;
    private final Paging paging;

    public NotificationController(NotificationService notifications, Paging paging) {
        this.notifications = notifications;
        this.paging = paging;
    }

    /** {@code GET /api/v1/notifications?unread=&limit=&cursor=}. */
    @GetMapping
    public Map<String, Object> list(@RequestParam(required = false) String unread,
                                    @RequestParam(required = false) String limit,
                                    @RequestParam(required = false) String cursor,
                                    HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID userId = Req.userId(request);
        int size = paging.limit(limit);
        int offset = paging.offset(cursor);
        Map<String, Object> out = new LinkedHashMap<>(notifications.list(tenant, userId,
                Paging.booleanFilter(unread), size, offset));
        out.put("unread_count", notifications.unreadCount(tenant, userId));
        return out;
    }

    @PostMapping("/{id}/read")
    public Map<String, Object> markRead(@PathVariable String id, HttpServletRequest request) {
        UUID notificationId = Json.uuidOrNull(id);
        if (notificationId == null) {
            throw ApiException.validation("Notification id must be a uuid", Json.map("field", "id"));
        }
        return notifications.markRead(Req.tenant(request), notificationId, Req.userId(request));
    }

    /** Marks the whole visible inbox read. Idempotent by construction (a second call changes nothing). */
    @PostMapping("/read-all")
    public Map<String, Object> markAllRead(HttpServletRequest request) {
        int updated = notifications.markAllRead(Req.tenant(request), Req.userId(request));
        return Json.map("marked_read", updated);
    }

    @GetMapping("/preferences")
    public Map<String, Object> preferences(HttpServletRequest request) {
        return notifications.preferences(Req.tenant(request), Req.userId(request));
    }

    /** {@code {"in_app":bool,"email":bool,"push":bool}} — unknown keys are a 422, not ignored. */
    @PutMapping("/preferences")
    public Map<String, Object> setPreferences(@RequestBody Map<String, Object> body, HttpServletRequest request) {
        return notifications.setPreferences(Req.tenant(request), Req.userId(request), body);
    }
}
