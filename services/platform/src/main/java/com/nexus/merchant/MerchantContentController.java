package com.nexus.merchant;

import com.nexus.analytics.AnalyticsRepository;
import com.nexus.catalog.FactRepository;
import com.nexus.catalog.OfferingRepository;
import com.nexus.catalog.ReservationService;
import com.nexus.platform.ApiException;
import com.nexus.platform.AuditService;
import com.nexus.platform.DemoFlags;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.Principal;
import com.nexus.platform.Req;
import com.nexus.platform.RequiresAuth;
import com.nexus.platform.RequiresPermission;
import com.nexus.platform.TenantContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The §5 merchant workspace write surface: onboarding, verification, publish, offering edits and the
 * §23 dashboard/export. This is the controller {@code com.nexus.merchant} shipped without (STATUS:
 * "ships no controller at all"), so the whole write path had no HTTP entry point and no integration
 * test.
 *
 * <p>Where an existing service already owns the behaviour it is called, never re-implemented:
 * {@link MerchantService} owns the merchant profile, verification, publish guards and hours;
 * {@code OfferingRepository} owns offering rows; {@code FactRepository} owns the trust layer. What
 * lives here is orchestration, request validation and the two things those services cannot express
 * on their own — a publish that <em>refuses</em> with a specific error code instead of returning a
 * workflow with {@code failed_guards}, and a bulk offering write that is atomic per item.
 *
 * <p>Orchestration sits in the controller because this stream owns no service file. The transaction
 * boundaries are explicit ({@link TransactionTemplate}) rather than {@code @Transactional}, so a
 * per-item rollback inside the bulk loop is unambiguous.
 */
@RestController
@RequestMapping("/api/v1/merchant")
public class MerchantContentController {

    private static final List<String> OFFERING_KINDS = List.of("product", "service", "experience");
    private static final List<String> PRICE_MODELS = List.of("fixed", "from_price", "per_person", "hourly", "range");
    private static final List<String> PRICE_SOURCES = List.of("merchant", "imported", "observed", "estimated");
    private static final List<String> OFFERING_STATUSES = List.of("draft", "active", "archived", "out_of_stock");
    private static final Pattern TIME = Pattern.compile("\\d{2}:\\d{2}(:\\d{2})?");
    /** AGENT_CONTRACT §5 maps {@code capacity} to a 24h freshness class. */
    private static final Duration CAPACITY_TTL = Duration.ofHours(24);
    private static final int MAX_BULK_ITEMS = 200;
    private static final int EXPORT_OFFERING_LIMIT = 500;

    private final MerchantService merchantService;
    private final MerchantRepository merchants;
    private final OfferingRepository offerings;
    private final FactRepository facts;
    private final MerchantContentRepository content;
    private final MerchantImportRepository imports;
    private final AnalyticsRepository analytics;
    private final ReservationService reservations;
    private final Paging paging;
    private final AuditService audit;
    private final TransactionTemplate tx;

    public MerchantContentController(MerchantService merchantService, MerchantRepository merchants,
                                     OfferingRepository offerings, FactRepository facts,
                                     MerchantContentRepository content, MerchantImportRepository imports,
                                     AnalyticsRepository analytics, ReservationService reservations,
                                     Paging paging, AuditService audit,
                                     PlatformTransactionManager transactionManager) {
        this.merchantService = merchantService;
        this.merchants = merchants;
        this.offerings = offerings;
        this.facts = facts;
        this.content = content;
        this.imports = imports;
        this.analytics = analytics;
        this.reservations = reservations;
        this.paging = paging;
        this.audit = audit;
        this.tx = new TransactionTemplate(transactionManager);
    }

    // ==================================================================== businesses

    /**
     * {@code POST /api/v1/merchant/businesses} — creates the merchant, the owner membership and the
     * owner's grant rows (the RBAC source of truth, §48). No {@code @RequiresPermission}: the acting
     * user is creating the subject the permission would be checked against, and the owner grants are
     * written by {@link MerchantService#createBusiness}.
     */
    @PostMapping("/businesses")
    @RequiresAuth
    public ResponseEntity<Map<String, Object>> createBusiness(@RequestBody Map<String, Object> body,
                                                             HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        Principal principal = Req.principal(request);
        rejectNonProfileFields(body);
        Map<String, Object> profile = profileFields(body);
        requireText(profile.get("legal_name"), "legal_name");
        requireText(profile.get("display_name"), "display_name");
        List<Map<String, Object>> locations = locationsOf(body);
        // Validated before any write: a bad hour row must not leave a half-created business behind.
        List<Map<String, Object>> hours = hoursOf(body);
        List<UUID> categoryIds = categoryIds(tenant, body);

        Map<String, Object> out = merchantService.createBusiness(tenant, principal, profile, locations);
        UUID merchantId = uuid(Json.str(asMap(out.get("merchant")), "merchant_id"), "merchant_id");
        if (!categoryIds.isEmpty()) {
            content.replaceCategories(tenant, merchantId, categoryIds);
        }
        if (!hours.isEmpty()) {
            applyHours(tenant, merchantId, hours);
        }
        return ResponseEntity.status(201).body(out);
    }

    /**
     * {@code PATCH /api/v1/merchant/businesses/{id}} — profile edit plus the two child collections the
     * §21 onboarding form carries ({@code location}/{@code locations}, {@code business_hours}). A field
     * whose write belongs to another permission ({@code ai_agent_enabled} → {@code configure_ai}) is
     * refused rather than silently dropped.
     */
    @PatchMapping("/businesses/{id}")
    @RequiresPermission(value = MerchantPermissions.WRITE_PROFILE, merchant = "business:id")
    public Map<String, Object> updateBusiness(@PathVariable String id, @RequestBody Map<String, Object> body,
                                              HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(id, "id");
        rejectNonProfileFields(body);
        List<Map<String, Object>> hours = hoursOf(body);
        List<UUID> categoryIds = categoryIds(tenant, body);

        Map<String, Object> out = merchantService.updateBusiness(tenant, merchantId, Req.principal(request),
                profileFields(body));
        if (body.containsKey("category_ids")) {
            content.replaceCategories(tenant, merchantId, categoryIds);
        }
        List<Map<String, Object>> addedLocations = new ArrayList<>();
        for (Map<String, Object> location : locationsOf(body)) {
            addedLocations.add(merchantService.addLocation(tenant, merchantId, location));
        }
        if (!hours.isEmpty()) {
            applyHours(tenant, merchantId, hours);
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("merchant", out);
        response.put("locations", merchants.locations(tenant, merchantId).stream()
                .map(MerchantRepository::locationView).toList());
        response.put("business_hours", hoursView(tenant, merchantId));
        return response;
    }

    /**
     * {@code POST /api/v1/merchant/businesses/{id}/verification} — §48 trust submission.
     *
     * <p>§5 does not define this body. {@code packages/types} sends {@code {documents[], note}} while
     * {@link MerchantService#verify} requires a business-registration reference, so a documents-only
     * submission uses the first document's own {@code uri}/{@code name} as that reference — a value the
     * caller supplied, never one invented here. Verification in this build is self-attested and the
     * response says so.
     */
    @PostMapping("/businesses/{id}/verification")
    @RequiresPermission(value = MerchantPermissions.WRITE_PROFILE, merchant = "business:id")
    public Map<String, Object> verify(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body,
                                      HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(id, "id");
        Map<String, Object> payload = body == null ? new LinkedHashMap<>() : new LinkedHashMap<>(body);
        if (isBlank(text(payload.get("business_registration_number")))) {
            String reference = firstDocumentReference(payload.get("documents"));
            if (reference != null) {
                payload.put("business_registration_number", reference);
            }
        }
        return merchantService.verify(tenant, merchantId, Req.principal(request), payload);
    }

    /**
     * {@code POST /api/v1/merchant/businesses/{id}/publish} — a state transition with guards, not a
     * boolean write.
     *
     * <p>{@link MerchantService#publish} computes the guards and returns them in a {@code 200} body,
     * which is the wrong shape for a client that must not think the listing went live. Here an
     * incomplete listing is refused with {@code 409 listing_not_publishable} and the failed guards, and
     * a repeat publish of an already-published listing is a no-op that returns the same state
     * (idempotent). A suspended listing is delegated to the service, which owns that 403.
     */
    @PostMapping("/businesses/{id}/publish")
    @RequiresPermission(value = MerchantPermissions.PUBLISH_LISTING, merchant = "business:id")
    public Map<String, Object> publish(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(id, "id");
        Map<String, Object> row = merchants.require(tenant, merchantId);
        String status = Json.str(row, "status");
        List<String> guards = merchantService.guards(tenant, row);
        if (!guards.isEmpty() && !"suspended".equals(status)) {
            throw new ApiException(409, "listing_not_publishable",
                    "This listing is not publishable yet: " + String.join(", ", guards),
                    Json.map("merchant_id", merchantId.toString(), "status", status, "failed_guards", guards,
                            "hint", "Each guard names the step that clears it: POST /api/v1/merchant/businesses/{id}"
                                    + "/verification, PATCH /api/v1/merchant/businesses/{id} (description, "
                                    + "category_primary, location, business_hours), POST /api/v1/merchant/offerings"));
        }
        return merchantService.publish(tenant, merchantId, Req.principal(request));
    }

    // ==================================================================== offerings

    /** {@code POST /api/v1/merchant/offerings} — creates one offering and the fact its price cites. */
    @PostMapping("/offerings")
    @RequiresPermission(value = MerchantPermissions.WRITE_PRODUCTS, merchant = "body:merchant_id")
    public ResponseEntity<Map<String, Object>> createOffering(@RequestBody Map<String, Object> body,
                                                             HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(text(body.get("merchant_id")), "merchant_id");
        Map<String, Object> result = tx.execute(status -> createOfferingRow(tenant, merchantId, body));
        audit.record(request, "create_offering", "offering", Json.uuid(asMap(result.get("offering")), "offering_id"),
                merchantId, null, Json.map("slug", Json.str(asMap(result.get("offering")), "slug")),
                Json.map("source", "merchant_workspace"));
        return ResponseEntity.status(201).body(result);
    }

    /**
     * {@code PATCH /api/v1/merchant/offerings/{id}} — partial edit. The slug is immutable (the update
     * statement does not carry it, so accepting one would be a silent no-op). A price change writes a
     * new {@code merchant}-sourced fact; clearing a price expires the old one, because a fact that
     * outlives its claim is the §19 failure this layer exists to prevent.
     */
    @PatchMapping("/offerings/{id}")
    @RequiresPermission(value = MerchantPermissions.WRITE_PRODUCTS, merchant = "offering:id")
    public Map<String, Object> updateOffering(@PathVariable String id, @RequestBody Map<String, Object> body,
                                              HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID offeringId = uuid(id, "id");
        if (body.containsKey("slug")) {
            throw ApiException.validation("An offering slug is immutable; create a new offering instead",
                    Json.map("field", "slug"));
        }
        if (body.containsKey("name")) {
            requireText(body.get("name"), "name");
        }
        Map<String, Object> result = tx.execute(status -> {
            offerings.require(tenant, offeringId);
            Map<String, Object> fields = offeringFields(tenant, body);
            if (body.containsKey("category")) {
                fields.put("category_id", resolveCategory(tenant, text(body.get("category"))));
            }
            offerings.update(tenant, offeringId, fields);
            if (body.containsKey("price")) {
                BigDecimal amount = asDecimal(fields.get("price_amount"));
                if (amount != null) {
                    recordPriceFact(tenant, offeringId, merchantIdOf(tenant, offeringId), amount,
                            String.valueOf(fields.get("currency")));
                } else {
                    content.expireFacts(tenant, offeringId, "price");
                }
            }
            if (body.containsKey("stock_quantity")) {
                Integer stock = asInteger(fields.get("stock_quantity"));
                if (stock != null) {
                    recordCapacityFact(tenant, offeringId, merchantIdOf(tenant, offeringId), stock);
                } else {
                    content.expireFacts(tenant, offeringId, "capacity");
                }
            }
            return Json.map("offering", OfferingRepository.view(offerings.require(tenant, offeringId)));
        });
        audit.record(request, "update_offering", "offering", offeringId, null, null,
                Json.map("fields", body.keySet()), Json.map("source", "merchant_workspace"));
        return result;
    }

    /**
     * {@code DELETE /api/v1/merchant/offerings/{id}} — a soft delete ({@code status='archived'}), the
     * only delete {@code OfferingRepository} offers. The row keeps its price fact because it still
     * carries that price; it simply stops being readable as an active offering.
     */
    @DeleteMapping("/offerings/{id}")
    @RequiresPermission(value = MerchantPermissions.WRITE_PRODUCTS, merchant = "offering:id")
    public Map<String, Object> deleteOffering(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID offeringId = uuid(id, "id");
        Map<String, Object> before = offerings.require(tenant, offeringId);
        offerings.archive(tenant, offeringId);
        // Read before the write: an audit "before" taken afterwards can only ever say 'archived', which
        // records nothing about what the row was.
        audit.record(request, "archive_offering", "offering", offeringId, Json.uuid(before, "merchant_id"),
                Json.map("status", Json.str(before, "status")), Json.map("status", "archived"),
                Json.map("source", "merchant_workspace"));
        return Json.map("offering_id", offeringId.toString(), "status", "archived", "deleted", true,
                "hard_delete", false,
                "notice", "Offerings are archived, not destroyed: the row stays for order history and the "
                        + "consumer menu no longer lists it (status='archived').");
    }

    /**
     * {@code POST /api/v1/merchant/offerings/bulk} — all-or-nothing <em>per item</em>. Each row runs in
     * its own transaction, so a rejected row writes nothing at all and a created row is complete
     * (offering + its price/capacity fact). The response reports every item's outcome; a rejected row
     * can never appear as created.
     */
    @PostMapping("/offerings/bulk")
    @RequiresPermission(value = MerchantPermissions.WRITE_PRODUCTS, merchant = "body:merchant_id")
    public Map<String, Object> bulkOfferings(@RequestBody Map<String, Object> body, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(text(body.get("merchant_id")), "merchant_id");
        Object rawItems = body.get("items");
        if (!(rawItems instanceof List<?> list) || list.isEmpty()) {
            throw ApiException.validation("items must be a non-empty array", Json.map("field", "items"));
        }
        if (list.size() > MAX_BULK_ITEMS) {
            throw ApiException.validation("items must contain at most " + MAX_BULK_ITEMS + " rows",
                    Json.map("field", "items", "max", MAX_BULK_ITEMS, "given", list.size()));
        }
        List<Map<String, Object>> results = new ArrayList<>();
        int created = 0;
        int rejected = 0;
        for (int index = 0; index < list.size(); index++) {
            Object raw = list.get(index);
            if (!(raw instanceof Map<?, ?> map)) {
                results.add(rejected(index, ApiException.validation("Each item must be a JSON object",
                        Json.map("field", "items[" + index + "]"))));
                rejected++;
                continue;
            }
            try {
                Map<String, Object> row = tx.execute(status -> createOfferingRow(tenant, merchantId, cast(map)));
                Map<String, Object> view = asMap(row.get("offering"));
                results.add(Json.map("index", index, "status", "created",
                        "offering_id", view.get("offering_id"), "slug", view.get("slug"), "offering", view));
                created++;
            } catch (ApiException e) {
                results.add(rejected(index, e));
                rejected++;
            } catch (DuplicateKeyException e) {
                results.add(rejected(index, ApiException.conflict("slug_taken",
                        "This merchant already has an offering with that slug", Json.map())));
                rejected++;
            }
        }
        return Json.map("merchant_id", merchantId.toString(), "requested", list.size(), "created", created,
                "rejected", rejected,
                "atomicity", "per item: each row is its own transaction, so a rejected row writes nothing and "
                        + "a created row is complete",
                "results", results);
    }

    // ==================================================================== dashboard + export

    /** {@code GET /api/v1/merchant/dashboard/overview?merchant_id=} — the §23 numbers, honestly zeroed. */
    @GetMapping("/dashboard/overview")
    @RequiresPermission(value = MerchantPermissions.READ_ANALYTICS, merchant = "param:merchant_id")
    public Map<String, Object> dashboardOverview(@RequestParam String merchant_id, HttpServletRequest request,
                                                 HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(merchant_id, "merchant_id");
        Map<String, Object> profile = analytics.merchantProfile(tenant, merchantId);
        if (profile == null) {
            throw ApiException.notFound("merchant_not_found", "No such business");
        }
        Map<String, Object> funnel = analytics.merchantFunnel(tenant, merchantId);
        long views = longOf(funnel, "views");
        long clicks = longOf(funnel, "clicks");
        long actions = longOf(funnel, "actions");
        long reservations = longOf(funnel, "reservations");
        long orders = longOf(funnel, "orders");
        BigDecimal revenue = funnel == null ? BigDecimal.ZERO : Json.dec(funnel, "revenue");
        String currency = funnel == null ? null : Json.str(funnel, "currency");
        String dataOrigin = Json.str(profile, "data_origin");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId.toString());
        out.put("as_of", Instant.now().toString());
        out.put("views", views);
        out.put("clicks", clicks);
        out.put("actions", actions);
        out.put("reservations", reservations);
        out.put("orders", orders);
        out.put("revenue", Json.money(revenue == null ? BigDecimal.ZERO : revenue,
                currency == null || currency.isBlank() ? tenant.currency() : currency));
        // A rate with a zero denominator has no value — null, never 0.0 (D6: an unknown is not a zero).
        out.put("conversion", Json.map("view_to_click", ratio(clicks, views),
                "click_to_action", ratio(actions, clicks), "action_to_order", ratio(orders, actions)));
        out.put("open_conversations", content.openConversations(tenant, merchantId));
        out.put("pending_proposals", imports.proposalCount(tenant, merchantId));
        out.put("data_origin", dataOrigin);
        out.put("funnel_source", "v_merchant_funnel");
        out.put("definitions", Json.map(
                "revenue", "sum(orders.total) for status not in (cancelled, refunded)",
                "pending_proposals", "offerings with status='draft' created by an import (§5.1) — nothing "
                        + "publishes without merchant review",
                "open_conversations", "conversations with status in (open, handoff)"));
        DemoFlags.markOrigin(response, dataOrigin);
        response.setHeader("Cache-Control", "no-store");
        return out;
    }

    /**
     * {@code GET /api/v1/merchant/export?merchant_id=} — §107 data ownership. §5 does not define the
     * payload; the merchant's own workspace rows are returned as one JSON bundle, bounded, with the
     * bounds stated rather than silently truncating.
     */
    @GetMapping("/export")
    @RequiresPermission(value = MerchantPermissions.READ_PRODUCTS, merchant = "param:merchant_id")
    public Map<String, Object> export(@RequestParam String merchant_id, HttpServletRequest request,
                                      HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(merchant_id, "merchant_id");
        Map<String, Object> row = merchants.require(tenant, merchantId);
        List<Map<String, Object>> offeringRows = content.exportOfferings(tenant, merchantId, EXPORT_OFFERING_LIMIT);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("merchant_id", merchantId.toString());
        out.put("exported_at", Instant.now().toString());
        out.put("format", "json");
        out.put("owner", "merchant");
        out.put("merchant", MerchantRepository.view(row));
        out.put("locations", merchants.locations(tenant, merchantId).stream()
                .map(MerchantRepository::locationView).toList());
        out.put("business_hours", hoursView(tenant, merchantId));
        out.put("offerings", offeringRows.stream().map(MerchantContentController::exportOffering).toList());
        out.put("offerings_total", offerings.countByMerchant(tenant, merchantId, null, null));
        out.put("offerings_limit", EXPORT_OFFERING_LIMIT);
        out.put("notice", "This export is the merchant's own workspace data (§107). Knowledge-base documents "
                + "are listed by GET /api/v1/merchant/knowledge-base; consumer-side personal data is not part "
                + "of a merchant export.");
        DemoFlags.markOrigin(response, Json.str(row, "data_origin"));
        response.setHeader("Cache-Control", "no-store");
        return out;
    }

    // ==================================================================== booking inbox (§23)

    /** The five states {@code reservations.status} allows (V1:306) — the filter cannot name a sixth. */
    private static final List<String> RESERVATION_STATUSES =
            List.of("pending", "confirmed", "cancelled", "completed", "no_show");

    /**
     * {@code GET /api/v1/merchant/reservations?status&amp;from&amp;to&amp;merchant_id&amp;limit&amp;cursor}
     * — the §23 booking inbox the merchant console and the {@code read_orders} agent tool both point at,
     * and the route that did not exist until now (the drift ledger filed it as "documented, not served").
     *
     * <p>Sorted by arrival, soonest first, and not by a client-chosen key: a pending hold for tonight is a
     * different problem from one next month, and an inbox that lets the caller reorder it makes the second
     * look like the first. {@code status} is the only narrowing the route offers besides the window.
     *
     * <p>Contact details are present because calling the guest is the whole job of this screen (§107 gives
     * the merchant its workspace data). The platform's own {@code user_id} is <em>not</em> — it identifies
     * a person to us, not to the merchant, and the phone number in {@code contact} already does the work.
     * Everything here sits behind {@code read_orders} on {@code merchant_id}, checked before a row is read.
     */
    @GetMapping("/reservations")
    @RequiresPermission(value = MerchantPermissions.READ_ORDERS, merchant = "param:merchant_id")
    public Map<String, Object> reservationInbox(@RequestParam String merchant_id,
                                                @RequestParam(required = false) String status,
                                                @RequestParam(required = false) String from,
                                                @RequestParam(required = false) String to,
                                                @RequestParam(required = false) String limit,
                                                @RequestParam(required = false) String cursor,
                                                HttpServletRequest request,
                                                HttpServletResponse response) {
        TenantContext tenant = Req.tenant(request);
        UUID merchantId = uuid(merchant_id, "merchant_id");
        String statusFilter = Paging.enumFilter(status, RESERVATION_STATUSES, "status");
        Instant windowFrom = instant(from, "from");
        Instant windowTo = instant(to, "to");
        int size = paging.limit(limit);
        int offset = paging.offset(cursor);

        ReservationService.Inbox inbox = reservations.inbox(tenant, merchantId, statusFilter, windowFrom,
                windowTo, size, offset);
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> row : inbox.items()) {
            items.add(inboxItem(row));
        }
        response.setHeader("Cache-Control", "no-store");

        Map<String, Object> page = paging.page(items, offset, size, inbox.total());
        page.put("merchant_id", merchantId.toString());
        page.put("filters", Json.map("status", statusFilter, "from", windowFrom == null ? null : windowFrom.toString(),
                "to", windowTo == null ? null : windowTo.toString()));
        page.put("sort", "starts_at asc");
        page.put("definitions", Json.map("pending", "held, not yet accepted by the merchant",
                "confirmed", "accepted — POST /reservations/{id}/accept is the route that moves a "
                        + "booking here, on manage_reservations (D26)",
                "total_estimate", "rows matching the same filter as this page, across pages"));
        page.put("notice", "An empty inbox is the real state: no reservations are seeded (§109), so rows "
                + "appear only from bookings made against this deployment.");
        return page;
    }

    /**
     * {@code POST /api/v1/merchant/reservations/{id}/accept} — the merchant's yes, the one transition
     * D26 held open until the vocabulary named who may make it. Behind {@code manage_reservations}
     * (owners and managers; deliberately not staff, API keys or the agent): confirming a hold is a
     * promise about a real evening, not an inbox tidy-up. The seats do not move — they left the pool
     * when the guest booked — so the slot in the response is the same pool the inbox showed, read
     * after the write.
     */
    @PostMapping("/reservations/{id}/accept")
    @RequiresPermission(value = MerchantPermissions.MANAGE_RESERVATIONS, merchant = "reservation:id")
    public Map<String, Object> acceptReservation(@PathVariable String id, HttpServletRequest request) {
        TenantContext tenant = Req.tenant(request);
        Map<String, Object> held = reservations.find(tenant, uuid(id, "id"))
                .orElseThrow(() -> ApiException.notFound("reservation_not_found", "No such booking"));
        ReservationService.Acceptance accepted = reservations.accept(tenant, held);
        Map<String, Object> row = accepted.row();
        audit.record(request, "reservation_accept", "reservation", Json.uuid(row, "id"),
                Json.uuid(row, "merchant_id"),
                accepted.replay() ? null : Json.map("status", "pending", "code", Json.str(row, "code")),
                Json.map("status", Json.str(row, "status"), "code", Json.str(row, "code"),
                        "replay", accepted.replay()),
                null);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("changed", !accepted.replay());
        out.put("reservation", inboxItem(row));
        UUID slotId = Json.uuidOrNull(Json.str(row, "slot_id"));
        if (slotId != null) {
            out.put("slot", reservations.slotAfter(tenant, slotId)
                    .map(s -> Json.map("id", Json.str(s, "id"),
                            "capacity_left", Json.integer(s, "capacity_left")))
                    .orElse(null));
        }
        out.put("status_note", accepted.replay()
                ? "This booking was already accepted; the seats stayed out of the pool and nothing was rewritten."
                : "Accepted. The seats stay out of the pool — the guest keeps the table unless they release it.");
        return out;
    }

    /** One inbox row: what was held, when, for how many, and how to reach the guest about it. */
    private static Map<String, Object> inboxItem(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("reservation_id", Json.str(row, "id"));
        out.put("code", Json.str(row, "code"));
        out.put("status", Json.str(row, "status"));
        out.put("source", Json.str(row, "source"));
        out.put("starts_at", Json.ts(row, "starts_at"));
        out.put("ends_at", Json.ts(row, "ends_at"));
        out.put("party_size", Json.integer(row, "party_size"));
        out.put("price", Json.money(row, "total_amount", "currency"));
        out.put("contact", Json.jsonObject(row, "contact"));
        out.put("notes", Json.str(row, "notes"));
        out.put("slot_id", Json.str(row, "slot_id"));
        out.put("offering_id", Json.str(row, "offering_id"));
        out.put("created_at", Json.ts(row, "created_at"));
        out.put("updated_at", Json.ts(row, "updated_at"));
        return out;
    }

    /** ISO-8601 instant or a 422 naming the field — never a silently ignored typo in a date filter. */
    private static Instant instant(String raw, String field) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(raw.trim());
        } catch (Exception e) {
            throw ApiException.validation(field + " must be an ISO-8601 instant",
                    Json.map("field", field, "received", raw));
        }
    }

    // ==================================================================== internals

    /** One offering row, written inside the caller's transaction, plus the facts its numbers cite. */
    private Map<String, Object> createOfferingRow(TenantContext tenant, UUID merchantId, Map<String, Object> body) {
        String name = requireText(body.get("name"), "name");
        Map<String, Object> fields = offeringFields(tenant, body);
        fields.put("name", name);
        fields.put("kind", enumValue(body.get("kind"), OFFERING_KINDS, "kind", "product"));
        fields.putIfAbsent("currency", tenant.currency());
        String slug = text(body.get("slug"));
        if (slug == null || slug.isBlank()) {
            slug = MerchantService.slugify(name);
            if (slug == null) {
                throw ApiException.validation("A slug could not be derived from name; send slug explicitly",
                        Json.map("field", "slug"));
            }
        } else {
            String normalised = MerchantService.slugify(slug);
            slug = normalised == null ? slug : normalised;
        }
        fields.put("slug", slug);
        fields.put("category_id", resolveCategory(tenant, text(body.get("category"))));
        UUID offeringId;
        try {
            offeringId = offerings.insert(tenant, merchantId, fields);
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("slug_taken",
                    "This merchant already has an offering with that slug", Json.map("slug", slug));
        }
        recordPriceFact(tenant, offeringId, merchantId, asDecimal(fields.get("price_amount")),
                String.valueOf(fields.get("currency")));
        recordCapacityFact(tenant, offeringId, merchantId, asInteger(fields.get("stock_quantity")));
        return Json.map("offering", OfferingRepository.view(offerings.require(tenant, offeringId)));
    }

    /** Normalised offering fields; only the keys the body actually carries are returned (partial update). */
    private Map<String, Object> offeringFields(TenantContext tenant, Map<String, Object> body) {
        Map<String, Object> f = new LinkedHashMap<>();
        if (body.containsKey("name_zh")) {
            f.put("name_zh", text(body.get("name_zh")));
        }
        if (body.containsKey("description")) {
            f.put("description", text(body.get("description")));
        }
        if (body.containsKey("description_zh")) {
            f.put("description_zh", text(body.get("description_zh")));
        }
        if (body.containsKey("kind")) {
            f.put("kind", enumValue(body.get("kind"), OFFERING_KINDS, "kind", "product"));
        }
        if (body.containsKey("price_model")) {
            f.put("price_model", enumValue(body.get("price_model"), PRICE_MODELS, "price_model", "fixed"));
        }
        if (body.containsKey("price_source")) {
            f.put("price_source", enumValue(body.get("price_source"), PRICE_SOURCES, "price_source", "merchant"));
        }
        if (body.containsKey("status")) {
            f.put("status", enumValue(body.get("status"), OFFERING_STATUSES, "status", "active"));
        }
        if (body.containsKey("price")) {
            Object price = body.get("price");
            f.put("price_amount", moneyAmount(price));
            f.put("currency", moneyCurrency(price, tenant.currency()));
        }
        putDecimal(f, body, "price_min");
        putDecimal(f, body, "price_max");
        putInteger(f, body, "stock_quantity");
        putInteger(f, body, "min_party_size");
        putInteger(f, body, "max_party_size");
        putInteger(f, body, "duration_minutes");
        if (body.containsKey("bookable")) {
            f.put("bookable", asBoolean(body.get("bookable")));
        }
        for (String json : List.of("images", "attributes", "constraints", "options")) {
            if (body.containsKey(json)) {
                f.put(json, body.get(json));
            }
        }
        return f;
    }

    /** Resolves the optional {@code category} reference, rejecting an unknown one before the write. */
    private UUID resolveCategory(TenantContext tenant, String reference) {
        if (reference == null || reference.isBlank()) {
            return null;
        }
        return content.categoryId(tenant, reference).orElseThrow(() -> ApiException.validation(
                "Unknown category", Json.map("field", "category", "value", reference)));
    }

    private void recordPriceFact(TenantContext tenant, UUID offeringId, UUID merchantId, BigDecimal amount,
                                 String currency) {
        if (amount == null) {
            return;
        }
        String code = currency == null || currency.isBlank() ? tenant.currency() : currency;
        // Same value shape ImportService writes for an imported price ({amount, currency}) — one shape,
        // so the offering card's `price` fact cannot mean two things (D25).
        facts.record(tenant, "offering", offeringId, merchantId, "price",
                Json.map("amount", amount.setScale(2, RoundingMode.HALF_UP).toPlainString(), "currency", code),
                null, code, "merchant", 1.0, FactRepository.PRICE_TTL);
    }

    private void recordCapacityFact(TenantContext tenant, UUID offeringId, UUID merchantId, Integer stock) {
        if (stock == null) {
            return;
        }
        facts.record(tenant, "offering", offeringId, merchantId, "capacity", Json.map("quantity", stock),
                null, null, "merchant", 1.0, CAPACITY_TTL);
    }

    /** The offering's merchant, re-read from the tenant-scoped row (never trusted from the request). */
    private UUID merchantIdOf(TenantContext tenant, UUID offeringId) {
        return Json.uuid(offerings.require(tenant, offeringId), "merchant_id");
    }

    private void applyHours(TenantContext tenant, UUID merchantId, List<Map<String, Object>> hours) {
        for (Map<String, Object> hour : hours) {
            merchantService.addHours(tenant, merchantId, hour);
        }
    }

    private List<Map<String, Object>> hoursView(TenantContext tenant, UUID merchantId) {
        return merchants.businessHours(tenant, merchantId).stream()
                .map(h -> Json.map("weekday", Json.integer(h, "weekday"),
                        "opens_at", Json.time(h, "opens_at"), "closes_at", Json.time(h, "closes_at"),
                        "crosses_midnight", Json.bool(h, "crosses_midnight"),
                        "location_id", Json.str(h, "location_id")))
                .toList();
    }

    /** Profile columns only: {@link MerchantRepository} owns these names, {@code avg_price} is the wire spelling. */
    private static Map<String, Object> profileFields(Map<String, Object> body) {
        Map<String, Object> f = new LinkedHashMap<>();
        copy(f, body, "legal_name");
        copy(f, body, "display_name");
        copy(f, body, "display_name_zh");
        copy(f, body, "description");
        copy(f, body, "category_primary");
        copy(f, body, "contact");
        copy(f, body, "socials");
        copy(f, body, "price_band");
        copy(f, body, "tags");
        copy(f, body, "attributes");
        copy(f, body, "images");
        copy(f, body, "seo");
        if (body.containsKey("avg_price")) {
            f.put("avg_price_hkd", body.get("avg_price"));
        }
        if (body.containsKey("slug")) {
            f.put("slug", body.get("slug"));
        }
        return f;
    }

    /**
     * A field whose write belongs to a different permission is refused, not silently ignored. §5 gives
     * {@code ai_agent_enabled} to {@code configure_ai}, which this route does not hold.
     */
    private static void rejectNonProfileFields(Map<String, Object> body) {
        if (body.containsKey("ai_agent_enabled")) {
            throw ApiException.validation("ai_agent_enabled is owned by POST /api/v1/merchant/ai-agent/config "
                            + "(permission configure_ai), not by the profile route",
                    Json.map("field", "ai_agent_enabled", "permission", MerchantPermissions.CONFIGURE_AI));
        }
    }

    private List<UUID> categoryIds(TenantContext tenant, Map<String, Object> body) {
        Object raw = body.get("category_ids");
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw ApiException.validation("category_ids must be an array of uuids", Json.map("field", "category_ids"));
        }
        List<UUID> out = new ArrayList<>();
        for (Object value : list) {
            String ref = text(value);
            out.add(content.categoryId(tenant, ref).orElseThrow(() -> ApiException.validation("Unknown category id",
                    Json.map("field", "category_ids", "value", ref))));
        }
        return out;
    }

    private static List<Map<String, Object>> locationsOf(Map<String, Object> body) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (body.get("location") instanceof Map<?, ?> single) {
            out.add(locationFields(cast(single)));
        }
        if (body.get("locations") instanceof List<?> list) {
            for (Object value : list) {
                if (value instanceof Map<?, ?> map) {
                    out.add(locationFields(cast(map)));
                }
            }
        }
        return out;
    }

    /**
     * Flattens the {@code {label, is_primary, address:{…, point:{lat,lng}}}} shape {@code packages/types}
     * declares into the flat {@code locations} columns. {@code address_line1}, {@code city} and the
     * coordinates are NOT NULL, so they are validated here to answer with a §1 envelope instead of a 500.
     */
    private static Map<String, Object> locationFields(Map<String, Object> raw) {
        Map<String, Object> address = raw.get("address") instanceof Map<?, ?> a ? cast(a) : Map.of();
        Map<String, Object> point = address.get("point") instanceof Map<?, ?> p ? cast(p) : Map.of();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("label", text(raw.get("label")));
        out.put("address_line1", firstNonBlank(text(raw.get("address_line1")), text(address.get("address_line1"))));
        out.put("address_line2", firstNonBlank(text(raw.get("address_line2")), text(address.get("address_line2"))));
        out.put("district", firstNonBlank(text(raw.get("district")), text(address.get("district"))));
        out.put("area", firstNonBlank(text(raw.get("area")), text(address.get("area"))));
        out.put("city", firstNonBlank(text(raw.get("city")), text(address.get("city"))));
        out.put("postcode", firstNonBlank(text(raw.get("postcode")), text(address.get("postcode"))));
        out.put("mtr_station", firstNonBlank(text(raw.get("mtr_station")), text(address.get("mtr_station"))));
        out.put("mtr_walk_min", firstNonNull(asInteger(raw.get("mtr_walk_min")),
                asInteger(address.get("mtr_walk_min"))));
        out.put("lat", firstNonNull(asDecimal(raw.get("lat")), asDecimal(address.get("lat")),
                asDecimal(point.get("lat"))));
        out.put("lng", firstNonNull(asDecimal(raw.get("lng")), asDecimal(address.get("lng")),
                asDecimal(point.get("lng"))));
        out.put("is_primary", raw.getOrDefault("is_primary", true));
        out.put("geo_properties", raw.get("geo_properties"));
        requireText(out.get("address_line1"), "location.address.address_line1");
        requireText(out.get("city"), "location.address.city");
        if (out.get("lat") == null || out.get("lng") == null) {
            throw ApiException.validation("location.address.point.lat and .lng are required",
                    Json.map("field", "location.address.point"));
        }
        return out;
    }

    /** Validated before any write, so a malformed row cannot leave a partially onboarded business. */
    private static List<Map<String, Object>> hoursOf(Map<String, Object> body) {
        Object raw = body.get("business_hours");
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw ApiException.validation("business_hours must be an array", Json.map("field", "business_hours"));
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object value : list) {
            if (!(value instanceof Map<?, ?> map)) {
                throw ApiException.validation("Each business_hours entry must be an object",
                        Json.map("field", "business_hours"));
            }
            Map<String, Object> hour = cast(map);
            Integer weekday = asInteger(hour.get("weekday"));
            String opens = text(hour.get("opens_at"));
            String closes = text(hour.get("closes_at"));
            if (weekday == null || weekday < 0 || weekday > 6) {
                throw ApiException.validation("business_hours.weekday must be 0 (Mon) .. 6 (Sun)",
                        Json.map("field", "business_hours.weekday"));
            }
            if (opens == null || closes == null || !TIME.matcher(opens).matches()
                    || !TIME.matcher(closes).matches()) {
                throw ApiException.validation("business_hours.opens_at and closes_at must be HH:MM",
                        Json.map("fields", List.of("opens_at", "closes_at")));
            }
            out.add(Json.map("weekday", weekday, "opens_at", opens, "closes_at", closes,
                    "location_id", hour.get("location_id")));
        }
        return out;
    }

    private static String firstDocumentReference(Object documents) {
        if (!(documents instanceof List<?> list)) {
            return null;
        }
        for (Object value : list) {
            if (value instanceof Map<?, ?> map) {
                Map<String, Object> document = cast(map);
                String reference = firstNonBlank(text(document.get("uri")), text(document.get("name")));
                if (reference != null) {
                    return reference;
                }
            }
        }
        return null;
    }

    private static Map<String, Object> rejected(int index, ApiException e) {
        return Json.map("index", index, "status", "rejected",
                "error", Json.map("code", e.code(), "message", e.getMessage(), "details", e.details()));
    }

    private static Map<String, Object> exportOffering(Map<String, Object> row) {
        return Json.map("offering_id", Json.str(row, "id"), "kind", Json.str(row, "kind"),
                "slug", Json.str(row, "slug"), "name", Json.str(row, "name"), "name_zh", Json.str(row, "name_zh"),
                "description", Json.str(row, "description"),
                "price", Json.money(row, "price_amount", "currency"),
                "price_model", Json.str(row, "price_model"), "price_source", Json.str(row, "price_source"),
                "price_updated_at", Json.ts(row, "price_updated_at"),
                "stock_quantity", Json.integer(row, "stock_quantity"), "bookable", Json.bool(row, "bookable"),
                "status", Json.str(row, "status"),
                "created_at", Json.ts(row, "created_at"), "updated_at", Json.ts(row, "updated_at"));
    }

    // ---- tiny helpers ---------------------------------------------------

    private static Double ratio(long numerator, long denominator) {
        if (denominator <= 0) {
            return null;
        }
        return (double) numerator / (double) denominator;
    }

    private static long longOf(Map<String, Object> row, String column) {
        Long value = row == null ? null : Json.longOf(row, column);
        return value == null ? 0L : value;
    }

    private static String enumValue(Object raw, List<String> allowed, String field, String fallback) {
        if (raw == null) {
            return fallback;
        }
        String value = String.valueOf(raw).trim().toLowerCase(Locale.ROOT);
        if (!allowed.contains(value)) {
            throw ApiException.validation(field + " must be one of " + allowed,
                    Json.map("field", field, "allowed", allowed, "given", raw));
        }
        return value;
    }

    private static String requireText(Object raw, String field) {
        String value = text(raw);
        if (value == null || value.isBlank()) {
            throw ApiException.validation("'" + field + "' is required", Json.map("field", field));
        }
        return value;
    }

    private static String text(Object raw) {
        return raw == null ? null : String.valueOf(raw);
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    @SafeVarargs
    private static <T> T firstNonNull(T... values) {
        for (T value : values) {
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private static BigDecimal moneyAmount(Object price) {
        if (price instanceof Map<?, ?> map) {
            return asDecimal(cast(map).get("amount"));
        }
        return asDecimal(price);
    }

    private static String moneyCurrency(Object price, String fallback) {
        if (price instanceof Map<?, ?> map) {
            String currency = text(cast(map).get("currency"));
            return isBlank(currency) ? fallback : currency;
        }
        return fallback;
    }

    private static BigDecimal asDecimal(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof BigDecimal decimal) {
            return decimal;
        }
        if (raw instanceof Number number) {
            return new BigDecimal(number.toString());
        }
        String value = String.valueOf(raw).trim();
        if (value.isEmpty()) {
            return null;
        }
        try {
            return new BigDecimal(value);
        } catch (NumberFormatException e) {
            throw ApiException.validation("Expected a decimal number", Json.map("given", raw));
        }
    }

    private static Integer asInteger(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof Number number) {
            return number.intValue();
        }
        String value = String.valueOf(raw).trim();
        if (value.isEmpty()) {
            return null;
        }
        try {
            return Integer.valueOf(value);
        } catch (NumberFormatException e) {
            throw ApiException.validation("Expected an integer", Json.map("given", raw));
        }
    }

    private static Boolean asBoolean(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof Boolean bool) {
            return bool;
        }
        String value = String.valueOf(raw).trim().toLowerCase(Locale.ROOT);
        if (value.isEmpty()) {
            return null;
        }
        if ("true".equals(value) || "1".equals(value) || "yes".equals(value)) {
            return Boolean.TRUE;
        }
        if ("false".equals(value) || "0".equals(value) || "no".equals(value)) {
            return Boolean.FALSE;
        }
        throw ApiException.validation("Expected a boolean", Json.map("given", raw));
    }

    private static void putDecimal(Map<String, Object> target, Map<String, Object> body, String key) {
        if (body.containsKey(key)) {
            target.put(key, asDecimal(body.get(key)));
        }
    }

    private static void putInteger(Map<String, Object> target, Map<String, Object> body, String key) {
        if (body.containsKey(key)) {
            target.put(key, asInteger(body.get(key)));
        }
    }

    private static void copy(Map<String, Object> target, Map<String, Object> source, String key) {
        if (source.containsKey(key)) {
            target.put(key, source.get(key));
        }
    }

    private static UUID uuid(String raw, String field) {
        UUID parsed = Json.uuidOrNull(raw);
        if (parsed == null) {
            throw ApiException.validation("'" + field + "' must be a uuid", Json.map("field", field));
        }
        return parsed;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object raw) {
        return raw instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Map<?, ?> raw) {
        return (Map<String, Object>) raw;
    }
}
