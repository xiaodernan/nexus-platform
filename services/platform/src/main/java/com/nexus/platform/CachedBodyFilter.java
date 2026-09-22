package com.nexus.platform;

import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.FilterChain;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Buffers small JSON bodies so the permission interceptor can read {@code merchant_id} out of them
 * before the controller consumes the stream. Cap 256 KiB; non-JSON and empty bodies stream through
 * unbuffered.
 *
 * <p><b>A missing {@code Content-Length} is not a reason to skip the cache.</b> A client that streams
 * its body — chunked HTTP/1.1, an SDK posting a generator, {@code fetch} with a {@code ReadableStream} —
 * declares no length, and the previous reading of that case passed the request through raw. The
 * interceptor then read the body to the end to resolve {@code body:merchant_id}, and the controller's
 * own read hit EOF: a perfectly valid offering payload was answered 422 "Request could not be parsed",
 * while the identical bytes sent with a {@code Content-Length} returned 201. The framing decided, not
 * the request, which is the kind of bug a client can never fix from its side of the wire.
 *
 * <p>A body larger than the cap is refused rather than streamed, because the alternative is the same
 * trap with a different status: {@code body:} authorisation cannot be resolved without reading it, and
 * letting the interceptor consume an oversized stream would report a parse error for a request that
 * parsed fine. Every workspace write here is far below 256 KiB; nothing loses capability to that rule,
 * and the limit is stated in the response instead.
 */
public class CachedBodyFilter extends OncePerRequestFilter {

    private static final int MAX_BYTES = 256 * 1024;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String contentType = request.getContentType();
        long declared = request.getContentLengthLong();
        boolean json = contentType != null && contentType.toLowerCase().startsWith("application/json");
        // `declared == 0` is an explicit empty body: nothing to cache and nothing to read.
        if (!json || declared == 0) {
            chain.doFilter(request, response);
            return;
        }
        byte[] body = readCapped(request.getInputStream());
        if (body == null) {
            tooLarge(response);
            return;
        }
        chain.doFilter(new Cached(request, body), response);
    }

    /** The body, or {@code null} when it exceeds {@link #MAX_BYTES} — reading no further either way. */
    private static byte[] readCapped(java.io.InputStream in) throws IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8_192];
        int total = 0;
        int read;
        while ((read = in.read(chunk)) != -1) {
            total += read;
            if (total > MAX_BYTES) {
                return null;
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    /** §1's envelope, written the way the other pre-controller filters write it. */
    private static void tooLarge(HttpServletResponse response) throws IOException {
        response.setStatus(422);
        response.setContentType("application/json");
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(Json.write(ApiExceptionHandler.envelope("validation_error",
                "Request body is larger than the 256 KiB this service reads",
                Map.of("reason", "request_body_too_large", "max_bytes", MAX_BYTES),
                RequestIds.current())));
    }

    private static final class Cached extends HttpServletRequestWrapper {
        private final byte[] body;

        Cached(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream in = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public boolean isFinished() {
                    return in.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener listener) {
                    // synchronous read model only
                }

                @Override
                public int read() {
                    return in.read();
                }
            };
        }

        @Override
        public BufferedReader getReader() {
            return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
        }
    }
}
