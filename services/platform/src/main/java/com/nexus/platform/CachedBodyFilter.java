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
import org.springframework.util.StreamUtils;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Buffers small JSON bodies so the permission interceptor can read {@code merchant_id} out of them
 * before the controller consumes the stream. Cap 256 KiB; anything larger or non-JSON streams
 * through unbuffered.
 */
public class CachedBodyFilter extends OncePerRequestFilter {

    private static final int MAX_BYTES = 256 * 1024;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String contentType = request.getContentType();
        long len = request.getContentLengthLong();
        boolean cacheable = contentType != null && contentType.toLowerCase().startsWith("application/json")
                && len > 0 && len <= MAX_BYTES;
        if (!cacheable) {
            chain.doFilter(request, response);
            return;
        }
        byte[] body = StreamUtils.copyToByteArray(request.getInputStream());
        if (body.length > MAX_BYTES) {
            chain.doFilter(request, response);
            return;
        }
        chain.doFilter(new Cached(request, body), response);
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
