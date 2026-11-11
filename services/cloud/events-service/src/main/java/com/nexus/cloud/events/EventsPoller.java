package com.nexus.cloud.events;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** The scheduled tick that drains {@code nexus:events} into the in-memory ring. */
@Component
public class EventsPoller {

    private static final Logger log = LoggerFactory.getLogger(EventsPoller.class);

    private final EventsReader reader;

    public EventsPoller(EventsReader reader) {
        this.reader = reader;
    }

    @Scheduled(fixedDelayString = "${nexus.events.poll-ms:1000}",
               initialDelayString = "${nexus.events.initial-poll-ms:200}")
    public void tick() {
        reader.pollOnce();
    }
}
