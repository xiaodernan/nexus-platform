package com.nexus.platform;

import java.util.UUID;
import org.slf4j.MDC;

/** The request id lives in the MDC (structured logs) and a thread local so the advice can echo it. */
public final class RequestIds {

    public static final String MDC_KEY = "request_id";
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private RequestIds() {
    }

    public static void set(String requestId) {
        CURRENT.set(requestId);
        MDC.put(MDC_KEY, requestId);
    }

    public static String current() {
        return CURRENT.get();
    }

    public static void clear() {
        CURRENT.remove();
        MDC.remove(MDC_KEY);
    }

    public static UUID asUuidOrNull(String value) {
        if (value == null) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
