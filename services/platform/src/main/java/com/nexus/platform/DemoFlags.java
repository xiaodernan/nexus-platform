package com.nexus.platform;

import jakarta.servlet.http.HttpServletResponse;

/**
 * D6 honesty rule: responses built from seeded/synthetic rows carry {@code X-Demo-Data: true} (and
 * {@code flags.demo} / {@code data_origin} in the payload) so nothing synthetic can be mistaken for
 * real market activity.
 */
public final class DemoFlags {

    public static final String HEADER = "X-Demo-Data";

    private DemoFlags() {
    }

    public static void mark(HttpServletResponse response, boolean demo) {
        if (demo) {
            response.setHeader(HEADER, "true");
        }
    }

    public static boolean isDemo(String dataOrigin) {
        return dataOrigin == null || "demo".equalsIgnoreCase(dataOrigin);
    }

    public static void markOrigin(HttpServletResponse response, String dataOrigin) {
        mark(response, isDemo(dataOrigin));
    }
}
