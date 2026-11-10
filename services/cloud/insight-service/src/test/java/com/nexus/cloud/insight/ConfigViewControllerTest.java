package com.nexus.cloud.insight;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;

import org.junit.jupiter.api.Test;

/** The view copies the resolved label verbatim; it never invents a healthy or remote-sounding one. */
class ConfigViewControllerTest {

    @Test
    void theLocalDefaultIsNamedHonestly() {
        Map<String, Object> body = new ConfigViewController("local").config();
        assertEquals("local", body.get("config_label"));
        assertEquals("nexus-insight", body.get("service"));
    }

    @Test
    void aResolvedLabelIsCopiedVerbatim() {
        Map<String, Object> body = new ConfigViewController("refresh-v2").config();
        assertEquals("refresh-v2", body.get("config_label"));
    }

    @Test
    void theViewIsReadOnlyAndCarriesNoUpstreamState() {
        Map<String, Object> body = new ConfigViewController("cloud-smoke").config();
        assertEquals(3, body.size());
        assertEquals(false, body.containsKey("all_up"));
        assertEquals(false, body.containsKey("upstreams"));
    }
}
