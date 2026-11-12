package com.nexus.cloud.dispatcher;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class HookPropertiesTest {

    @Test
    void itMatchesByExplicitEventType() {
        HookProperties props = new HookProperties();
        var hook = new HookProperties.Hook();
        hook.setEventTypes("LeadCaptured");
        hook.setUri("https://example.com/hook");
        hook.setSecret("secret");
        hook.setEnabled(true);
        props.setHooks(java.util.Map.of("h1", hook));
        assertThat(hook.matches("LeadCaptured")).isTrue();
        assertThat(hook.matches("ReservationChanged")).isFalse();
    }

    @Test
    void itMatchesStarAsWildcard() {
        var hook = new HookProperties.Hook();
        hook.setEventTypes("*");
        hook.setUri("https://example.com");
        hook.setSecret("s");
        hook.setEnabled(true);
        assertThat(hook.matches("anything")).isTrue();
        assertThat(hook.matches("")).isTrue();
    }

    @Test
    void itMatchesPrefixWithTrailingStar() {
        var hook = new HookProperties.Hook();
        hook.setEventTypes("Reservation*,Order*");
        hook.setUri("https://example.com");
        hook.setSecret("s");
        hook.setEnabled(true);
        assertThat(hook.matches("ReservationChanged")).isTrue();
        assertThat(hook.matches("OrderStatusChanged")).isTrue();
        assertThat(hook.matches("LeadCaptured")).isFalse();
    }

    @Test
    void itCountsOnlyEnabledHooks() {
        HookProperties props = new HookProperties();
        var hook = new HookProperties.Hook();
        hook.setUri("https://example.com");
        hook.setSecret("s");
        hook.setEnabled(false);
        var enabledHook = new HookProperties.Hook();
        enabledHook.setUri("https://example.com");
        enabledHook.setSecret("s");
        enabledHook.setEnabled(true);
        props.setHooks(java.util.Map.of("disabled", hook, "enabled", enabledHook));
        assertThat(props.enabledHookCount()).isEqualTo(1L);
    }

    @Test
    void itExposesNoSecretsInThePublicView() {
        HookProperties props = new HookProperties();
        var hook = new HookProperties.Hook();
        hook.setId("h");
        hook.setEventTypes("t");
        hook.setUri("https://example.com");
        hook.setSecret("this-should-never-leak");
        hook.setEnabled(true);
        props.setHooks(java.util.Map.of("h", hook));
        Map<String, Object> map = new LinkedHashMap<>();
        props.publicHooks().forEach((k, v) -> map.put(k, v));
        assertThat(map.toString()).doesNotContain("this-should-never-leak");
    }
}
