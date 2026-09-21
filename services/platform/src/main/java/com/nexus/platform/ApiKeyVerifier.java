package com.nexus.platform;

import java.util.Optional;
import java.util.UUID;

/**
 * SPI implemented by the merchant module: a merchant API key ({@code nx_*}) authenticates as
 * {@code subject_type='api_key'} with the key's merchant + scopes. Declared in platform so the
 * auth filter never depends on a business module.
 */
public interface ApiKeyVerifier {

    Optional<Principal> verify(String rawKey, TenantContext tenant);

    /** Called on every authenticated request so {@code api_keys.last_used_at} stays honest. */
    void touch(UUID keyId);
}
