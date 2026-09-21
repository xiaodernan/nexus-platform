package com.nexus.platform;

import java.util.Map;

/**
 * The only way application code signals an HTTP failure. Maps 1:1 onto the error envelope in
 * docs/API_CONTRACT.md §1: {@code {"error":{"code","message","details","request_id"}}}.
 *
 * <p>Codes: validation_error(422) unauthorized(401) forbidden(403) not_found(404) conflict(409)
 * rate_limited(429) ai_unavailable(503) internal(500). Resource-specific 404 codes
 * (e.g. {@code merchant_not_found}) are allowed and preferred — cross-tenant reads must use them so
 * the response is 404, never 403 (DECISIONS D5, no enumeration).
 */
public class ApiException extends RuntimeException {

    private final int status;
    private final String code;
    private final Map<String, Object> details;

    public ApiException(int status, String code, String message, Map<String, Object> details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details == null ? Map.of() : details;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    public Map<String, Object> details() {
        return details;
    }

    // ---- factories -------------------------------------------------------

    public static ApiException validation(String message, Map<String, Object> details) {
        return new ApiException(422, "validation_error", message, details);
    }

    public static ApiException unauthorized(String code, String message) {
        return new ApiException(401, code, message, Map.of());
    }

    public static ApiException forbidden(String message, Map<String, Object> details) {
        return new ApiException(403, "forbidden", message, details);
    }

    public static ApiException notFound(String code, String message) {
        return new ApiException(404, code, message, Map.of());
    }

    public static ApiException conflict(String code, String message, Map<String, Object> details) {
        return new ApiException(409, code, message, details);
    }

    public static ApiException rateLimited(String message, long retryAfterSeconds) {
        return new ApiException(429, "rate_limited", message, Map.of("retry_after", retryAfterSeconds));
    }

    public static ApiException aiUnavailable(String message) {
        return new ApiException(503, "ai_unavailable", message, Map.of());
    }

    /** D7: an unimplemented path must say so loudly (501), never fake success. */
    public static ApiException notImplemented(String message) {
        return new ApiException(501, "not_implemented", message, Map.of());
    }

    public static ApiException internal(String message, Throwable cause) {
        ApiException e = new ApiException(500, "internal", message, Map.of());
        e.initCause(cause);
        return e;
    }
}
