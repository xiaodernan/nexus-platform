package com.nexus.platform;

import jakarta.validation.ConstraintViolationException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/** Renders every failure as the single error envelope from API_CONTRACT §1. */
@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    public static Map<String, Object> envelope(String code, String message, Map<String, Object> details, String requestId) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        error.put("details", details == null ? Map.of() : details);
        error.put("request_id", requestId);
        return Map.of("error", error);
    }

    private ResponseEntity<Object> build(int status, String code, String message, Map<String, Object> details,
                                         String requestId) {
        return ResponseEntity.status(status)
                .header("X-Request-Id", requestId == null ? "unknown" : requestId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .body(envelope(code, message, details, requestId));
    }

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Object> handleApi(ApiException e) {
        String rid = RequestIds.current();
        if (e.status() >= 500) {
            log.error("request_failed code={} message={}", e.code(), e.getMessage(), e);
        } else {
            log.info("request_rejected status={} code={} message={}", e.status(), e.code(), e.getMessage());
        }
        return build(e.status(), e.code(), e.getMessage(), e.details(), rid);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Object> handleValidation(MethodArgumentNotValidException e) {
        Map<String, Object> fields = new LinkedHashMap<>();
        for (FieldError fe : e.getBindingResult().getFieldErrors()) {
            fields.put(Json.snake(fe.getField()), fe.getDefaultMessage());
        }
        return build(422, "validation_error", "Request body failed validation", Map.of("fields", fields),
                RequestIds.current());
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<Object> handleConstraint(ConstraintViolationException e) {
        Map<String, Object> details = new LinkedHashMap<>();
        e.getConstraintViolations().forEach(v -> details.put(v.getPropertyPath().toString(), v.getMessage()));
        return build(422, "validation_error", "Request failed validation", details, RequestIds.current());
    }

    @ExceptionHandler(MissingRequestHeaderException.class)
    public ResponseEntity<Object> handleMissingHeader(MissingRequestHeaderException e) {
        return build(422, "validation_error", "Missing required header",
                Map.of("header", e.getHeaderName()), RequestIds.current());
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Object> handleUnreadable(Exception e) {
        return build(422, "validation_error", "Request could not be parsed",
                Map.of("reason", e.getClass().getSimpleName()), RequestIds.current());
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Object> handleNoResource(NoResourceFoundException e) {
        return build(404, "not_found", "No such endpoint", Map.of(), RequestIds.current());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Object> handleOther(Exception e) {
        log.error("unhandled_exception type={} message={}", e.getClass().getName(), e.getMessage(), e);
        return build(500, "internal", "The service failed to handle this request", Map.of(), RequestIds.current());
    }
}
