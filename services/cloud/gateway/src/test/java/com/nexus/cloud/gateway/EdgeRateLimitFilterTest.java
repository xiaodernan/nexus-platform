package com.nexus.cloud.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;

/** D917 — the edge's bucket map evicts the coldest entry, never everything. */
class EdgeRateLimitFilterTest {

    @Test
    void theBucketMapEvictsTheLeastRecentlyUsedEntryBeyondTheCap() {
        Map<String, TokenBucket> buckets = EdgeRateLimitFilter.newBucketMap(2);
        buckets.computeIfAbsent("a", k -> new TokenBucket(10, 0));
        buckets.computeIfAbsent("b", k -> new TokenBucket(10, 0));
        buckets.get("a");                                     // touch a — a is now most recent
        buckets.computeIfAbsent("c", k -> new TokenBucket(10, 0)); // c evicts the LRU entry (b)
        assertThat(buckets).doesNotContainKey("b");
        assertThat(buckets).containsKey("a").containsKey("c");
    }

    @Test
    void theBucketMapNeverExceedsItsCapEvenUnderAnAlternatingKeyspace() {
        Map<String, TokenBucket> buckets = EdgeRateLimitFilter.newBucketMap(3);
        for (int i = 0; i < 64; i++) {
            buckets.computeIfAbsent("client-" + i, k -> new TokenBucket(10, 0));
        }
        assertThat(buckets.size()).isLessThanOrEqualTo(3);
        assertThat(buckets).containsKey("client-63");
    }

    @Test
    void aFloodOfCoolClientsDoesNotResetAnActiveClientsBucket() {
        Map<String, TokenBucket> buckets = EdgeRateLimitFilter.newBucketMap(4);
        // the active client is touched between every cool client, so it stays hot
        TokenBucket hot = buckets.computeIfAbsent("hot", k -> new TokenBucket(1, 0));
        assertThat(hot.tryAcquire()).isTrue();                 // the only token is consumed
        for (int i = 0; i < 10; i++) {
            buckets.get("hot");                               // keep hot alive between cold inserts
            buckets.computeIfAbsent("cool-" + i, k -> new TokenBucket(1, 0));
        }
        assertThat(buckets).containsKey("hot");               // never evicted under the old clear()
        assertThat(hot.tryAcquire()).isFalse();                // capacity consumed, not reset
    }
}
