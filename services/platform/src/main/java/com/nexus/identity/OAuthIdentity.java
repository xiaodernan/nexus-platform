package com.nexus.identity;

/**
 * Verified third-party identity from an OAuth {@code id_token} (API_CONTRACT §3). A subject is the
 * provider's opaque id — never a token.
 */
public record OAuthIdentity(String provider, String subject, String email, String displayName, String locale) {
}
