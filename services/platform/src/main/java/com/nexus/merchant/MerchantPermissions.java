package com.nexus.merchant;

import java.util.List;

/**
 * The workspace permission vocabulary from API_CONTRACT §5, plus the default grant sets written into
 * {@code permission_grants}. AI-facing roles deliberately never receive {@code publish_campaign} or
 * {@code refund_payment} (AGENT_CONTRACT §8).
 */
public final class MerchantPermissions {

    public static final String WRITE_PROFILE = "write_profile";
    public static final String PUBLISH_LISTING = "publish_listing";
    public static final String READ_PRODUCTS = "read_products";
    public static final String WRITE_PRODUCTS = "write_products";
    public static final String READ_ORDERS = "read_orders";
    public static final String READ_ANALYTICS = "read_analytics";
    public static final String CONFIGURE_AI = "configure_ai";
    public static final String SEND_MESSAGE = "send_message";
    public static final String CREATE_DRAFT_CAMPAIGN = "create_draft_campaign";
    public static final String PUBLISH_CAMPAIGN = "publish_campaign";
    public static final String ADMIN_MEMBERS = "admin_members";
    public static final String CREATE_RESERVATION = "create_reservation";

    /** Everything a human owner needs; written as explicit grant rows, not inferred from the role. */
    public static final List<String> OWNER = List.of(
            WRITE_PROFILE, PUBLISH_LISTING, READ_PRODUCTS, WRITE_PRODUCTS, READ_ORDERS, READ_ANALYTICS,
            CONFIGURE_AI, SEND_MESSAGE, CREATE_DRAFT_CAMPAIGN, PUBLISH_CAMPAIGN, ADMIN_MEMBERS,
            CREATE_RESERVATION);

    /** Staff: can serve customers and read the catalogue, cannot manage members or publish. */
    public static final List<String> STAFF = List.of(
            READ_PRODUCTS, WRITE_PRODUCTS, SEND_MESSAGE, CREATE_RESERVATION, READ_ORDERS);

    /** Manager: staff plus profile editing and analytics, but no member admin and no campaign publish. */
    public static final List<String> MANAGER = List.of(
            WRITE_PROFILE, READ_PRODUCTS, WRITE_PRODUCTS, READ_ORDERS, READ_ANALYTICS, SEND_MESSAGE,
            CREATE_RESERVATION, CREATE_DRAFT_CAMPAIGN);

    /** Read-only analyst. */
    public static final List<String> ANALYST = List.of(READ_PRODUCTS, READ_ANALYTICS, READ_ORDERS);

    /**
     * Default grants for the merchant AI agent (§24-26): read + draft only. It may never publish a
     * campaign (§27) or refund, and answering is scoped to its own merchant.
     */
    public static final List<String> AI_AGENT = List.of(
            READ_PRODUCTS, READ_ANALYTICS, SEND_MESSAGE, CREATE_DRAFT_CAMPAIGN);

    /** API keys get an explicit scope list chosen by the creator; these are the recognised values. */
    public static final List<String> API_KEY_SCOPES = List.of(
            "read_products", "write_products", "read_orders", "read_analytics", "send_message",
            "create_reservation");

    public static List<String> defaultsForRole(String role) {
        return switch (role == null ? "staff" : role) {
            case "owner", "admin" -> OWNER;
            case "manager" -> MANAGER;
            case "analyst" -> ANALYST;
            case "ai_agent" -> AI_AGENT;
            default -> STAFF;
        };
    }

    public static final List<String> ROLES = List.of("owner", "admin", "manager", "staff", "marketing", "analyst",
            "ai_agent");

    private MerchantPermissions() {
    }
}
