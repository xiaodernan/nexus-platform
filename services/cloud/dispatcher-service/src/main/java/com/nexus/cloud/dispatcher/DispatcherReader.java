package com.nexus.cloud.dispatcher;

import io.lettuce.core.Consumer;
import io.lettuce.core.RedisClient;
import io.lettuce.core.XAutoClaimArgs;
import io.lettuce.core.XGroupCreateArgs;
import io.lettuce.core.XReadArgs;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.models.stream.ClaimedMessages;
import io.lettuce.core.models.stream.PendingMessages;
import io.lettuce.core.StreamMessage;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The stream poll loop. Subscribes to {@code nexus:events} under its own consumer group
 * ({@code nexus-dispatchers}), splits deliveries to the worker, ACKs only after handoff.
 * Same structural shape as the sibling {@code events-service}'s reader: group create on first
 * poll, BUSYGROUP swallowed, autoclaim from dead peers, bounded work per tick.
 */
@Component
public class DispatcherReader {

    private static final Logger log = LoggerFactory.getLogger(DispatcherReader.class);
    private static final String STREAM_KEY = "nexus:events";
    private static final String GROUP_NAME = "nexus-dispatchers";
    private static final String PENDING_OFFSET = "0";
    private static final String NEW_OFFSET = ">";
    private static final String AUTOCLAIM_CURSOR = "0-0";

    private final HookProperties props;
    private final DispatcherWorker worker;
    private final AtomicLong dispatched = new AtomicLong();
    private final AtomicLong skipped = new AtomicLong();
    private final AtomicLong parked = new AtomicLong();

    private RedisClient client;
    private StatefulRedisConnection<String, String> connection;
    private final String consumerName;
    private boolean groupReady = false;

    @Autowired
    public DispatcherReader(HookProperties props, DispatcherWorker worker) {
        this.props = props;
        this.worker = worker;
        this.consumerName = UUID.randomUUID().toString();
    }

    /** Fixed-cadence poll. Disabled doors never touch the wire. */
    @Scheduled(fixedDelayString = "${nexus.dispatcher.poll-ms:1000}",
               initialDelayString = "${nexus.dispatcher.initial-poll-ms:200}")
    public void pollOnce() {
        if (!props.isEnabled()) return;
        try {
            ensureConnection();
            pollGroup();
        } catch (Exception e) {
            log.warn("dispatcher poll_failed reason={}", e.toString());
        }
    }

    private void pollGroup() {
        ensureGroup();
        Consumer<String> me = Consumer.from(GROUP_NAME, consumerName);
        XReadArgs args = new XReadArgs().count(50).block(Duration.ofMillis(50));

        // 1) Replay this consumer's own unacked entries.
        drain(me, args, XReadArgs.StreamOffset.from(STREAM_KEY, PENDING_OFFSET));
        // 2) New entries never delivered to this group.
        drain(me, args, XReadArgs.StreamOffset.from(STREAM_KEY, NEW_OFFSET));
        // 3) Reclaim entries idle past 60s from DEAD peers.
        reclaimDeadPending(me);
    }

    private void reclaimDeadPending(Consumer<String> me) {
        String cursor = AUTOCLAIM_CURSOR;
        for (int batch = 0; batch < 8; batch++) {
            XAutoClaimArgs<String> claimArgs = XAutoClaimArgs.Builder
                    .xautoclaim(me, 60_000L, cursor).count(50L);
            ClaimedMessages<String, String> claimed = connection.sync().xautoclaim(STREAM_KEY, claimArgs);
            List<StreamMessage<String, String>> claimedMsgs = claimed.getMessages();
            if (claimedMsgs == null || claimedMsgs.isEmpty()) return;
            for (StreamMessage<String, String> msg : claimedMsgs) {
                if (dispatch(msg)) {
                    Long n = connection.sync().xack(STREAM_KEY, GROUP_NAME, msg.getId());
                    if (n != null && n > 0) dispatched.incrementAndGet();
                } else {
                    parked.incrementAndGet();
                }
            }
            String next = claimed.getId();
            if (next == null || AUTOCLAIM_CURSOR.equals(next) || next.equals(cursor)) return;
            cursor = next;
        }
    }

    private void drain(Consumer<String> me, XReadArgs args,
                       XReadArgs.StreamOffset<String> offset) {
        List<StreamMessage<String, String>> messages = connection.sync().xreadgroup(me, args, offset);
        if (messages == null || messages.isEmpty()) return;
        for (StreamMessage<String, String> msg : messages) {
            if (dispatch(msg)) {
                Long n = connection.sync().xack(STREAM_KEY, GROUP_NAME, msg.getId());
                if (n != null && n > 0) dispatched.incrementAndGet();
            } else {
                parked.incrementAndGet();
            }
        }
    }

    private boolean dispatch(StreamMessage<String, String> msg) {
        DomainEvent event = DomainEvent.fromStreamBody(msg.getId(), msg.getBody());
        DispatcherWorker.EnqueueResult result = worker.submitIfMatch(event);
        switch (result) {
            case ENQUEUED: return true;
            case NO_HOOK_MATCHED: skipped.incrementAndGet(); return true;
            case QUEUE_FULL: return false; // leave pending, caller will park it
        }
        return false;
    }

    private void ensureConnection() {
        if (connection != null) return;
        client = RedisClient.create(props.getUrl());
        client.setOptions(io.lettuce.core.ClientOptions.builder()
                .autoReconnect(true)
                .disconnectedBehavior(io.lettuce.core.ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
                .build());
        connection = client.connect();
        connection.sync().ping();
        groupReady = false;
        log.info("dispatcher connected url={} stream={} enabled={}",
            props.getUrl(), STREAM_KEY, props.isEnabled());
    }

    private void ensureGroup() {
        if (groupReady) return;
        try {
            connection.sync().xgroupCreate(
                    XReadArgs.StreamOffset.from(STREAM_KEY, PENDING_OFFSET),
                    GROUP_NAME, XGroupCreateArgs.Builder.mkstream());
            log.info("dispatcher group created stream={} group={}", STREAM_KEY, GROUP_NAME);
        } catch (io.lettuce.core.RedisCommandExecutionException e) {
            if (!String.valueOf(e.getMessage()).contains("BUSYGROUP")) throw e;
        }
        groupReady = true;
    }

    public Map<String, Object> state() {
        java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("enabled", props.isEnabled());
        out.put("dispatched", dispatched.get());
        out.put("skipped", skipped.get());
        out.put("parked", parked.get());
        out.put("consumer", consumerName);
        out.put("group", GROUP_NAME);
        out.put("hooks", props.publicHooks());
        out.put("hookCount", props.enabledHookCount());
        out.put("worker", worker.state());
        try {
            PendingMessages pm = connection != null && groupReady
                ? connection.sync().xpending(STREAM_KEY, GROUP_NAME) : null;
            out.put("pending", pm == null ? 0L : pm.getCount());
        } catch (Exception e) {
            out.put("pending", "unavailable:" + e.getClass().getSimpleName());
        }
        return out;
    }

    public void closeQuietly() {
        try {
            if (connection != null) connection.close();
            if (client != null) client.shutdown();
        } catch (Exception ignored) { }
        connection = null;
        client = null;
        groupReady = false;
    }
}
