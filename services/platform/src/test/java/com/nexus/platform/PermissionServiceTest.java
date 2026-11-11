package com.nexus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.nexus.platform.TenantJdbc;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/** D912 — the grant lookup is a bounded LRU, flushed on every grant write, TTL-expiry strict. */
@ExtendWith(MockitoExtension.class)
class PermissionServiceTest {

    private static final UUID TENANT = UUID.randomUUID();
    private static final UUID MERCHANT = UUID.randomUUID();
    private static final UUID SUBJECT = UUID.randomUUID();
    private static final TenantContext TCTX =
            new TenantContext(TENANT, "test-tenant", "hkd", "Asia/Hong_Kong", "HK");

    @Mock
    private TenantJdbc jdbc;

    private PermissionService serviceWith(long ttlMs, int max) {
        return new PermissionService(jdbc, ttlMs, max);
    }

    private void grantNow(PermissionService service, UUID subjectId, UUID merchantId) {
        service.grant(TCTX, "merchant_user", subjectId, merchantId, "read_analytics", subjectId);
    }

    @Test
    void aGrantedAnswerIsServedFromCacheWithinTheTtl() {
        PermissionService service = serviceWith(10_000, 16);
        when(jdbc.forTenant(any(TenantContext.class), org.mockito.ArgumentMatchers.anyString(), any()))
                .thenReturn(List.of(Map.of("permission", "read_analytics")));
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isTrue();
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isTrue();
        verify(jdbc, times(1)).forTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void aDeniedAnswerIsServedFromCacheWithinTheTtl() {
        PermissionService service = serviceWith(10_000, 16);
        when(jdbc.forTenant(any(TenantContext.class), anyString(), any())).thenReturn(List.of());
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isFalse();
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isFalse();
        verify(jdbc, times(1)).forTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void aGrantIsVisibleToTheVeryNextLookup() {
        PermissionService service = serviceWith(10_000, 16);
        // the first answer is a denial; every endpoint the grant touches reads fresh afterwards
        when(jdbc.forTenant(any(TenantContext.class), anyString(), any()))
                .thenReturn(List.of())
                .thenReturn(List.of(Map.of("permission", "read_analytics")));
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isFalse();
        grantNow(service, SUBJECT, MERCHANT);
        // the cached negative must NOT be served; the grant forces a fresh look that sees the row
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isTrue();
        verify(jdbc, times(1)).crossTenantUpdate(anyString(), any());
    }

    @Test
    void aRevocationIsVisibleToTheVeryNextLookup() {
        PermissionService service = serviceWith(10_000, 16);
        when(jdbc.forTenant(any(TenantContext.class), anyString(), any()))
                .thenReturn(List.of(Map.of("permission", "read_analytics")), List.of());
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isTrue();
        service.revoke(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics");
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isFalse();
        verify(jdbc, times(2)).forTenant(any(TenantContext.class), anyString(), any());
        verify(jdbc, times(1)).updateForTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void entriesExpireAtTheTtl() throws Exception {
        PermissionService service = serviceWith(40, 16);
        when(jdbc.forTenant(any(TenantContext.class), anyString(), any())).thenReturn(List.of());
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isFalse();
        Thread.sleep(80);
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isFalse();
        verify(jdbc, times(2)).forTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void aZeroTtlNeverCaches() {
        PermissionService service = serviceWith(0, 16);
        when(jdbc.forTenant(any(TenantContext.class), anyString(), any())).thenReturn(List.of());
        service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "a");
        service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "a");
        verify(jdbc, times(2)).forTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void theLruBoundEvictsTheLeastRecentlyUsed() {
        PermissionService service = serviceWith(10_000, 2);
        when(jdbc.forTenant(any(TenantContext.class), anyString(), any())).thenReturn(List.of());
        UUID k1 = UUID.randomUUID();
        UUID k2 = UUID.randomUUID();
        UUID k3 = UUID.randomUUID();
        service.hasMerchantGrant(TCTX, "merchant_user", k1, MERCHANT, "p1");   // db, install k1
        service.hasMerchantGrant(TCTX, "merchant_user", k2, MERCHANT, "p2");   // db, install k2 (cap 2)
        service.hasMerchantGrant(TCTX, "merchant_user", k1, MERCHANT, "p1");   // cache hit
        service.hasMerchantGrant(TCTX, "merchant_user", k3, MERCHANT, "p3");   // db, evicts LRU (k2)
        service.hasMerchantGrant(TCTX, "merchant_user", k1, MERCHANT, "p1");   // cache hit (k1 survived)
        service.hasMerchantGrant(TCTX, "merchant_user", k2, MERCHANT, "p2");   // db, evicted → refetch
        verify(jdbc, times(4)).forTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void aDatabaseFailureIsNotCached() {
        PermissionService service = serviceWith(10_000, 16);
        when(jdbc.forTenant(any(TenantContext.class), anyString(), any()))
                .thenThrow(new RuntimeException("db down"))
                .thenReturn(List.of(Map.of("permission", "read_analytics")));
        assertThatThrownBy(() -> service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics"))
                .isInstanceOf(RuntimeException.class);
        assertThat(service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics")).isTrue();
        verify(jdbc, times(2)).forTenant(any(TenantContext.class), anyString(), any());
    }

    @Test
    void theTenantScopeIsCachedSeperatelyFromTheMerchantScope() {
        PermissionService service = serviceWith(10_000, 16);
        when(jdbc.forTenant(any(TenantContext.class), anyString(), any())).thenReturn(List.of());
        service.has(TCTX, "merchant_user", SUBJECT, null, "read_analytics");
        service.hasMerchantGrant(TCTX, "merchant_user", SUBJECT, MERCHANT, "read_analytics");
        // different cache entries: the zero-merchant check and the merchant check both hit the database
        verify(jdbc, times(2)).forTenant(any(TenantContext.class), anyString(), any());
    }
}
