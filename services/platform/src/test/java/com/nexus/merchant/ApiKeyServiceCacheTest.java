package com.nexus.merchant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.nexus.platform.AuditService;
import com.nexus.platform.PermissionService;
import com.nexus.platform.Principal;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * D933 — the key-verification hot path caches its answer (hit or miss) in a bounded access-order
 * LRU with a TTL, and `touch()` stops writing `last_used_at` on every authenticated request
 * (one UPDATE per key per throttle window). Same discipline D912 shipped for grant lookups.
 *
 * The integration harness does not pin these properties to bypass because no integration test
 * mutates `api_keys` rows or authenticates with a key secret — this suite is the owner of the
 * cache semantics, like PermissionServiceTest is for grant lookups.
 */
@ExtendWith(MockitoExtension.class)
class ApiKeyServiceCacheTest {

    private static final UUID TENANT = UUID.randomUUID();
    private static final UUID MERCHANT = UUID.randomUUID();
    private static final UUID KEY_ID = UUID.randomUUID();
    private static final UUID ACTOR = UUID.randomUUID();
    private static final TenantContext TCTX =
            new TenantContext(TENANT, "test-tenant", "hkd", "Asia/Hong_Kong", "HK");
    private static final String RAW_KEY = "nx_live_9f6edeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefde";

    @Mock
    private TenantJdbc jdbc;
    @Mock
    private PermissionService permissions;
    @Mock
    private AuditService audit;

    private ApiKeyService serviceWith(long ttlMs, int max, long throttleMs, int throttleMax) {
        return new ApiKeyService(jdbc, permissions, audit, ttlMs, max, throttleMs, throttleMax);
    }

    private static Map<String, Object> liveKeyRow() {
        return Map.of("id", KEY_ID, "merchant_id", MERCHANT);
    }

    // ---- verify cache ------------------------------------------------------

    @Test
    void aValidKeyIsServedFromCacheWithinTheTtl() {
        ApiKeyService service = serviceWith(10_000, 16, 0, 128);
        when(jdbc.firstForTenant(any(TenantContext.class), anyString(), any()))
                .thenReturn(Optional.of(liveKeyRow()));
        Principal first = service.verify(RAW_KEY, TCTX).orElseThrow();
        Principal second = service.verify(RAW_KEY, TCTX).orElseThrow();
        assertThat(second.subjectId()).isEqualTo(first.subjectId());
        assertThat(second.merchantId()).isEqualTo(MERCHANT);
        verify(jdbc, times(1)).firstForTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void aRejectedKeyIsCachedTooSoABadSecretLoopStopsAskingTheDatabase() {
        ApiKeyService service = serviceWith(10_000, 16, 0, 128);
        when(jdbc.firstForTenant(any(TenantContext.class), anyString(), any()))
                .thenReturn(Optional.empty());
        assertThat(service.verify(RAW_KEY, TCTX)).isEmpty();
        assertThat(service.verify(RAW_KEY, TCTX)).isEmpty();
        verify(jdbc, times(1)).firstForTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void aDatabaseFailureIsNotCached() {
        ApiKeyService service = serviceWith(10_000, 16, 0, 128);
        when(jdbc.firstForTenant(any(TenantContext.class), anyString(), any()))
                .thenThrow(new RuntimeException("db down"))
                .thenReturn(Optional.of(liveKeyRow()));
        assertThatThrownBy(() -> service.verify(RAW_KEY, TCTX))
                .isInstanceOf(RuntimeException.class);
        assertThat(service.verify(RAW_KEY, TCTX)).isPresent();
        verify(jdbc, times(2)).firstForTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void aRevocationIsVisibleToTheVeryNextVerifyThroughThisService() {
        ApiKeyService service = serviceWith(10_000, 16, 0, 128);
        when(jdbc.firstForTenant(any(TenantContext.class), anyString(), any()))
                .thenReturn(Optional.of(liveKeyRow()))          // before revoke: key is valid
                .thenReturn(Optional.empty());                 // after revoke: the row reads revoked
        assertThat(service.verify(RAW_KEY, TCTX)).isPresent();
        // the very next verify hits the warm cache even though nothing changed in the row
        assertThat(service.verify(RAW_KEY, TCTX)).isPresent();
        when(jdbc.updateForTenant(any(TenantContext.class), anyString(), any())).thenReturn(1);
        when(jdbc.crossTenantUpdate(anyString(), any())).thenReturn(1);
        service.revoke(TCTX, KEY_ID, ACTOR);
        // revoke flushes the map: the next verify re-reads the database and sees the revocation
        assertThat(service.verify(RAW_KEY, TCTX)).isEmpty();
        verify(jdbc, times(2)).firstForTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void entriesExpireAtTheTtl() throws Exception {
        ApiKeyService service = serviceWith(40, 16, 0, 128);
        when(jdbc.firstForTenant(any(TenantContext.class), anyString(), any()))
                .thenReturn(Optional.empty());
        service.verify(RAW_KEY, TCTX);
        Thread.sleep(80);
        service.verify(RAW_KEY, TCTX);
        verify(jdbc, times(2)).firstForTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void aZeroTtlNeverCaches() {
        ApiKeyService service = serviceWith(0, 16, 0, 128);
        when(jdbc.firstForTenant(any(TenantContext.class), anyString(), any()))
                .thenReturn(Optional.empty());
        service.verify(RAW_KEY, TCTX);
        service.verify(RAW_KEY, TCTX);
        verify(jdbc, times(2)).firstForTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void theLruBoundEvictsTheLeastRecentlyVerifyUsedKeyFirst() {
        ApiKeyService service = serviceWith(10_000, 2, 0, 128);
        when(jdbc.firstForTenant(any(TenantContext.class), anyString(), any()))
                .thenReturn(Optional.empty());
        service.verify("k1", TCTX);   // db, install k1
        service.verify("k2", TCTX);   // db, install k2 (cap 2)
        service.verify("k1", TCTX);   // cache hit, re-pins k1
        service.verify("k3", TCTX);   // db, evicts the least-recent k2
        service.verify("k1", TCTX);   // cache hit (k1 survived)
        service.verify("k2", TCTX);   // db again (k2 was evicted)
        verify(jdbc, times(4)).firstForTenant(any(TenantContext.class), anyString(), any());
    }

    // ---- touch throttle -----------------------------------------------------

    @Test
    void touchWritesLastUsedAtOncePerWindow() {
        ApiKeyService service = serviceWith(0, 16, 10_000, 128);
        service.touch(KEY_ID);
        service.touch(KEY_ID);
        service.touch(KEY_ID);
        verify(jdbc, times(1)).crossTenantUpdate(anyString(), any());
    }

    @Test
    void touchWritesAgainAfterTheWindowExpires() throws Exception {
        ApiKeyService service = serviceWith(0, 16, 40, 128);
        service.touch(KEY_ID);
        Thread.sleep(80);
        service.touch(KEY_ID);
        verify(jdbc, times(2)).crossTenantUpdate(anyString(), any());
    }

    @Test
    void aZeroThrottleWindowRestoresThePerRequestWrite() {
        ApiKeyService service = serviceWith(0, 16, 0, 128);
        service.touch(KEY_ID);
        service.touch(KEY_ID);
        verify(jdbc, times(2)).crossTenantUpdate(anyString(), any());
    }

    @Test
    void aFailedTouchIsRetriedOnTheNextRequestNotSilentlySuppressed() {
        ApiKeyService service = serviceWith(0, 16, 10_000, 128);
        when(jdbc.crossTenantUpdate(anyString(), any()))
                .thenThrow(new RuntimeException("db down"))
                .thenReturn(1);
        assertThatThrownBy(() -> service.touch(KEY_ID)).isInstanceOf(RuntimeException.class);
        service.touch(KEY_ID);
        verify(jdbc, times(2)).crossTenantUpdate(anyString(), any());
    }

    @Test
    void theTouchLruBoundEvictsTheLeastRecentlyTouchedKey() {
        ApiKeyService service = serviceWith(0, 16, 10_000, 2);
        UUID k1 = UUID.randomUUID();
        UUID k2 = UUID.randomUUID();
        UUID k3 = UUID.randomUUID();
        service.touch(k1);       // db, install k1
        service.touch(k2);       // db, install k2 (cap 2)
        service.touch(k1);       // cache hit, re-pins k1
        service.touch(k3);       // db, evicts k2
        service.touch(k1);       // cache hit (k1 kept its slot)
        service.touch(k2);       // db again (k2 was evicted)
        verify(jdbc, times(4)).crossTenantUpdate(anyString(), any());
    }
}
