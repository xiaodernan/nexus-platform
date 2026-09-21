package com.nexus.identity;

import java.util.Optional;

/**
 * Verifies a provider {@code id_token} and returns the identity inside it. Implementations:
 * {@link JwksOAuthVerifier} (real RS256 against the provider JWKS) and {@link DevOAuthVerifier}
 * (unsigned-token passthrough for local development, refused outside the dev profile).
 */
public interface OAuthTokenVerifier {

    String provider();

    /** Short, human-readable name of the verification mode; surfaced in the login response (§109 honesty). */
    String mode();

    /** Empty when the token does not verify. */
    Optional<OAuthIdentity> verify(String idToken);
}
