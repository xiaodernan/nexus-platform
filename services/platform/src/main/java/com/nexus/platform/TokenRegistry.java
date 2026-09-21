package com.nexus.platform;

import java.time.Duration;
import java.util.Optional;
import org.springframework.stereotype.Component;

/**
 * Refresh-token family state for rotation + reuse detection (API_CONTRACT §3). The family id is the
 * JWT {@code sid}; the store keeps the jti of the token that is currently allowed to be exchanged.
 * Presenting an older jti means the token leaked → the whole family is revoked and the caller gets
 * 401 {@code refresh_reuse_detected}.
 *
 * <p>State lives in {@link KeyValueStore} (Redis when reachable, in-process otherwise). Losing the
 * state (Redis restart) invalidates refresh families — an acceptable fail-closed trade-off, recorded
 * in the README.
 */
@Component
public class TokenRegistry {

    private final KeyValueStore store;

    public TokenRegistry(KeyValueStore store) {
        this.store = store;
    }

    private static String familyKey(String family) {
        return "nexus:refreshfam:" + family;
    }

    public void registerFamily(String family, String jti, Duration ttl) {
        store.set(familyKey(family), jti, ttl);
    }

    /** Marks {@code jti} as the current token of the family (rotation). */
    public void rotate(String family, String jti, Duration ttl) {
        store.set(familyKey(family), jti, ttl);
    }

    /** @return true when {@code jti} is the token this family expects right now. */
    public boolean accept(String family, String jti) {
        Optional<String> current = store.get(familyKey(family));
        // Unknown family: accept once and adopt it, so a store flush does not lock users out silently.
        if (current.isEmpty()) {
            return false;
        }
        return current.get().equals(jti);
    }

    public boolean familyKnown(String family) {
        return store.get(familyKey(family)).isPresent();
    }

    public void revoke(String family) {
        store.delete(familyKey(family));
    }
}
