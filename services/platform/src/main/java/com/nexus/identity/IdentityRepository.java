package com.nexus.identity;

import com.nexus.platform.ApiException;
import com.nexus.platform.Json;
import com.nexus.platform.Paging;
import com.nexus.platform.TenantContext;
import com.nexus.platform.TenantJdbc;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Repository;

/**
 * Identity data access. Every method takes {@link TenantContext} first and every statement carries a
 * {@code tenant_id} predicate (enforced by {@link TenantJdbc#forTenant}); child tables without their
 * own tenant column (user_preferences, favorites, saved_searches, ...) are reached through a JOIN to
 * {@code users}.
 */
@Repository
public class IdentityRepository {

    private static final String USER_COLUMNS = """
            u.id, u.email, u.phone, u.display_name, u.avatar_url, u.locale, u.role, u.status,
            u.marketing_opt_in, u.last_login_at, u.created_at, u.updated_at, u.tenant_id
            """;

    /**
     * The strength stored when someone declares a preference and states no strength. It is NOT the
     * schema's {@code DEFAULT 0.500}: in the ranker ({@code apps/ai/nexus_ai/search/service.py}) 0.5
     * is the point of no evidence - every matcher reflects a weight around it (D527), so a row at 0.5
     * scores a merchant exactly as the same merchant scores for a user who has no row at all. A
     * declared preference written at 0.5 is memory that is stored, listed to the user under §32, and
     * answers nothing. 0.7 sits inside the band the demo corpus's own declared rows occupy (0.4 to 1.0)
     * and below the strengths most of them state (0.8, 0.9, 0.95, 1.0), so a caller who said "I like X"
     * is ranked as someone who likes X, not as someone who said nothing.
     */
    public static final double DECLARED_PREFERENCE_WEIGHT = 0.7;

    /** The ranker's no-evidence point. Named so the write plane can say what it refuses to store. */
    public static final double NEUTRAL_PREFERENCE_WEIGHT = 0.5;

    private final TenantJdbc jdbc;

    public IdentityRepository(TenantJdbc jdbc) {
        this.jdbc = jdbc;
    }

    // ---- users ----------------------------------------------------------

    public Optional<Map<String, Object>> findUser(TenantContext tenant, UUID userId) {
        return jdbc.firstForTenant(tenant, "select " + USER_COLUMNS + " from users u "
                + "where u.id = :id and u.tenant_id = :tenant_id and u.deleted_at is null",
                Json.map("id", userId));
    }

    public Optional<Map<String, Object>> findUserByEmail(TenantContext tenant, String email) {
        return jdbc.firstForTenant(tenant, "select " + USER_COLUMNS + ", u.password_hash from users u "
                + "where u.email = :email and u.tenant_id = :tenant_id and u.deleted_at is null",
                Json.map("email", email));
    }

    public Map<String, Object> requireUser(TenantContext tenant, UUID userId) {
        return findUser(tenant, userId).orElseThrow(() -> ApiException.notFound("user_not_found", "No such user"));
    }

    /**
     * The merchant a membership row ties this user to, for the default scope of a freshly minted
     * token. Users with several merchants choose a workspace per request; this is only the first one.
     */
    public Optional<UUID> defaultMerchantId(TenantContext tenant, UUID userId) {
        return jdbc.firstForTenant(tenant, """
                select mu.merchant_id from merchant_users mu
                join merchants m on m.id = mu.merchant_id
                where mu.user_id = :user_id and m.tenant_id = :tenant_id and mu.status = 'active'
                order by mu.created_at
                """, Json.map("user_id", userId)).map(r -> Json.uuid(r, "merchant_id"));
    }

    public UUID insertUser(TenantContext tenant, String email, String passwordHash, String displayName,
                           String locale, String role, boolean marketingOptIn) {
        Map<String, Object> row = jdbc.insertForTenant(tenant, """
                insert into users (tenant_id, email, password_hash, display_name, locale, role, status, marketing_opt_in)
                values (:tenant_id, cast(:email as citext), cast(:password_hash as text), cast(:display_name as text),
                        :locale, :role, 'active', :marketing_opt_in)
                returning id
                """, Json.map("email", email, "password_hash", passwordHash, "display_name", displayName,
                "locale", locale == null ? "zh-HK" : locale, "role", role == null ? "consumer" : role,
                "marketing_opt_in", marketingOptIn));
        return Json.uuid(row, "id");
    }

    /**
     * Defense in depth for tables keyed only by {@code user_id} (preferences, favorites, saved
     * searches, deletion requests): the caller's account is verified live before any cross-tenant-shaped
     * statement runs.
     *
     * <p>Until D310 the verification was inert. This method called {@link TenantJdbc#crossTenant}, which
     * returns the rows, and threw the {@code List} away — so the {@code status = 'active'} predicate decided
     * nothing, and an erased subject whose access token had not yet expired passed the guard it existed to
     * refuse and filed rows on the account the platform had just erased. Reading the result is the whole fix.
     */
    public void requireUserInTenant(TenantContext tenant, UUID userId) {
        jdbc.crossTenantFirst("select 1 as ok from users u where u.id = :id and u.tenant_id = :tenant_id"
                        + " and u.status = 'active'",
                Json.map("id", userId, "tenant_id", tenant.tenantId()))
                .orElseThrow(() -> ApiException.notFound("user_not_found", "No such user"));
    }

    /**
     * The row's own PII columns, for a live subject. {@code deleted_at is null} is the statement's own
     * lifecycle predicate, not a copy of the door's read: {@code PATCH /api/v1/me} used to update the row,
     * file its audit row and only then read the user back — which answered {@code 404 user_not_found} for a
     * write that had landed, putting a display name, a phone and an avatar URL back onto a row the person had
     * just erased (D310). The controller reads its subject first so the answer matches the effect; this
     * predicate keeps a future caller that forgets that read from resurrecting an erased row at all.
     */
    public int updateProfile(TenantContext tenant, UUID userId, String displayName, String locale, String avatarUrl,
                            Boolean marketingOptIn, String phone) {
        return jdbc.updateForTenant(tenant, """
                update users u
                set display_name   = coalesce(cast(:display_name as text), display_name),
                    locale         = coalesce(cast(:locale as text), locale),
                    avatar_url     = coalesce(cast(:avatar_url as text), avatar_url),
                    phone          = coalesce(cast(:phone as text), phone),
                    marketing_opt_in = coalesce(cast(:marketing_opt_in as boolean), marketing_opt_in)
                where u.id = :id and u.tenant_id = :tenant_id and u.deleted_at is null
                """, Json.map("id", userId, "display_name", displayName, "locale", locale, "avatar_url", avatarUrl,
                "phone", phone, "marketing_opt_in", marketingOptIn));
    }

    public void touchLastLogin(TenantContext tenant, UUID userId) {
        jdbc.updateForTenant(tenant, "update users set last_login_at = now() where id = :id and tenant_id = :tenant_id",
                Json.map("id", userId));
    }

    /**
     * One entry per column §106 erasure rewrites, in statement order. {@code personal} separates the columns
     * that carry who the person is from the lifecycle columns the same statement moves.
     *
     * <p>Both lists the door publishes ({@link #erasedColumns()}, {@link #piiColumns()}) are read out of this
     * declaration, and the SQL's {@code set} clause is built from it, so the statement, the audit detail and
     * the response cannot disagree. They did at HEAD: the audit named four of the eight columns a hand-typed
     * list next to a hand-typed statement happened to overlap with, and {@code avatar_url} was rewritten
     * without ever being disclosed (D309).
     */
    public record ErasureColumn(String column, String expression, boolean personal) {
    }

    private static final List<ErasureColumn> ERASURE = List.of(
            new ErasureColumn("email", "null", true),
            new ErasureColumn("phone", "null", true),
            new ErasureColumn("password_hash", "null", true),
            new ErasureColumn("display_name", "'Deleted user'", true),
            new ErasureColumn("avatar_url", "null", true),
            new ErasureColumn("status", "'deleted'", false),
            new ErasureColumn("deleted_at", "now()", false),
            new ErasureColumn("marketing_opt_in", "false", false));

    private static final String ERASURE_SET = ERASURE.stream()
            .map(c -> c.column() + " = " + c.expression())
            .collect(java.util.stream.Collectors.joining(", "));

    public List<String> erasedColumns() {
        return ERASURE.stream().map(ErasureColumn::column).toList();
    }

    public List<String> piiColumns() {
        return ERASURE.stream().filter(ErasureColumn::personal).map(ErasureColumn::column).toList();
    }

    /** How many rows each of the two erasure statements wrote. */
    public record ErasureResult(int userRows, int identityLinksRemoved) {
    }

    /**
     * §106 erasure: this person's own identifier columns go, the accounting rows (orders, reservations) stay.
     *
     * <p>The identity links are deleted rather than kept: {@code user_identities.user_id} is declared
     * {@code ON DELETE CASCADE} — the schema already says these rows are the user's — and the soft erase above
     * means that cascade never fires, so at HEAD the person's email survived the erasure in
     * {@code provider_id}, which {@code AuthService.register} writes for every password account. Keeping the
     * row also poisoned the sign-in path: {@code oauth()} resolves a returning subject through that link and
     * only provisions a new account when no link exists, so an erased person signing in again with a provider
     * hit the deleted row and got {@code user_not_found} forever, while a re-registration of the same email
     * had its {@code linkIdentity} swallowed by the {@code on conflict ... do nothing}.
     */
    public ErasureResult eraseUser(TenantContext tenant, UUID userId) {
        int userRows = jdbc.updateForTenant(tenant,
                "update users set " + ERASURE_SET + " where id = :id and tenant_id = :tenant_id",
                Json.map("id", userId));
        int links = jdbc.updateForTenant(tenant,
                "delete from user_identities where user_id = :id and tenant_id = :tenant_id",
                Json.map("id", userId));
        return new ErasureResult(userRows, links);
    }

    public List<Map<String, Object>> listUsers(TenantContext tenant, int limit, int offset, String role,
                                              String search) {
        StringBuilder sql = new StringBuilder("select " + USER_COLUMNS + " from users u where u.tenant_id = :tenant_id");
        Map<String, Object> params = new java.util.LinkedHashMap<>();
        params.put("tenant_id", tenant.tenantId());
        if (role != null) {
            sql.append(" and u.role = :role");
            params.put("role", role);
        }
        if (search != null) {
            sql.append(" and (u.display_name ilike :q or coalesce(cast(u.email as text),'') ilike :q)");
            params.put("q", "%" + search + "%");
        }
        sql.append(" order by u.created_at desc limit :limit offset :offset");
        params.put("limit", limit);
        params.put("offset", offset);
        return jdbc.forTenant(tenant, sql.toString(), params);
    }

    public long countUsers(TenantContext tenant, String role, String search) {
        StringBuilder sql = new StringBuilder("select count(*) from users u where u.tenant_id = :tenant_id");
        Map<String, Object> params = new java.util.LinkedHashMap<>();
        params.put("tenant_id", tenant.tenantId());
        if (role != null) {
            sql.append(" and u.role = :role");
            params.put("role", role);
        }
        if (search != null) {
            sql.append(" and (u.display_name ilike :q or coalesce(cast(u.email as text),'') ilike :q)");
            params.put("q", "%" + search + "%");
        }
        return jdbc.countForTenant(tenant, sql.toString(), params);
    }

    public Optional<String> passwordHash(TenantContext tenant, UUID userId) {
        return jdbc.firstForTenant(tenant, "select u.password_hash as ph from users u "
                        + "where u.id = :id and u.tenant_id = :tenant_id", Json.map("id", userId))
                .map(r -> Json.str(r, "ph"));
    }

    public void setPasswordHash(TenantContext tenant, UUID userId, String hash) {
        jdbc.updateForTenant(tenant, "update users set password_hash = :hash where id = :id and tenant_id = :tenant_id",
                Json.map("id", userId, "hash", hash));
    }

    public void setRole(TenantContext tenant, UUID userId, String role, String status) {
        jdbc.updateForTenant(tenant, """
                update users set role = coalesce(cast(:role as text), role),
                                 status = coalesce(cast(:status as text), status)
                where id = :id and tenant_id = :tenant_id
                """, Json.map("id", userId, "role", role, "status", status));
    }

    // ---- oauth identities ----------------------------------------------

    public Optional<Map<String, Object>> findIdentity(TenantContext tenant, String provider, String providerId) {
        return jdbc.firstForTenant(tenant, """
                select ui.id, ui.user_id, ui.provider, ui.provider_id, ui.verified_at, ui.tenant_id
                from user_identities ui
                where ui.provider = :provider and ui.provider_id = :provider_id and ui.tenant_id = :tenant_id
                """, Json.map("provider", provider, "provider_id", providerId));
    }

    public void linkIdentity(TenantContext tenant, UUID userId, String provider, String providerId) {
        jdbc.crossTenantUpdate("""
                insert into user_identities (user_id, tenant_id, provider, provider_id, verified_at)
                values (:user_id, :tenant_id, :provider, :provider_id, now())
                on conflict (tenant_id, provider, provider_id) do nothing
                """, Json.map("user_id", userId, "tenant_id", tenant.tenantId(), "provider", provider,
                "provider_id", providerId));
    }

    public List<Map<String, Object>> identitiesOf(TenantContext tenant, UUID userId) {
        return jdbc.forTenant(tenant, """
                select ui.provider, ui.provider_id, ui.verified_at, ui.tenant_id
                from user_identities ui
                where ui.user_id = :user_id and ui.tenant_id = :tenant_id
                order by ui.created_at
                """, Json.map("user_id", userId));
    }

    // ---- preferences (§32, §33) ----------------------------------------

    public List<Map<String, Object>> listPreferences(TenantContext tenant, UUID userId, String kind) {
        StringBuilder sql = new StringBuilder("""
                select p.id, p.kind, p.key, p.value, p.weight, p.source, p.scope, p.expires_at,
                       p.created_at, p.updated_at, u.tenant_id
                from user_preferences p join users u on u.id = p.user_id
                where p.user_id = :user_id and u.tenant_id = :tenant_id
                """);
        Map<String, Object> params = new java.util.LinkedHashMap<>();
        params.put("user_id", userId);
        params.put("tenant_id", tenant.tenantId());
        if (kind != null) {
            sql.append(" and p.kind = :kind");
            params.put("kind", kind);
        }
        sql.append(" order by p.kind, p.key");
        return jdbc.forTenant(tenant, sql.toString(), params);
    }

    public Optional<Map<String, Object>> findPreference(TenantContext tenant, UUID userId, UUID id) {
        return jdbc.firstForTenant(tenant, """
                select p.id, p.kind, p.key, p.value, p.weight, p.source, p.scope, p.expires_at,
                       p.created_at, p.updated_at, u.tenant_id
                from user_preferences p join users u on u.id = p.user_id
                where p.id = :id and p.user_id = :user_id and u.tenant_id = :tenant_id
                """, Json.map("id", id, "user_id", userId));
    }

    public UUID upsertPreference(TenantContext tenant, UUID userId, String kind, String key, Object value,
                                 Double weight, String source, String scope, Integer ttlDays) {
        // Anchor verified: user_preferences has no tenant column, it hangs off users (verified above).
        requireUserInTenant(tenant, userId);
        java.time.OffsetDateTime expiresAt = ttlDays == null ? null
                : java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).plusDays(ttlDays);
        String resolvedSource = source == null ? "declared" : source;
        // A caller who declared a preference and said nothing about its strength did not say it is
        // neutral, so silence is not stored as 0.5: see DECLARED_PREFERENCE_WEIGHT for what the ranker
        // does with that number. An explicit weight - from any source, on either path - is stored as
        // given, including a number below 0.5, which the ranker reads as weak evidence FOR (D527).
        double insertWeight = weight != null ? weight
                : "declared".equals(resolvedSource) ? DECLARED_PREFERENCE_WEIGHT : NEUTRAL_PREFERENCE_WEIGHT;
        Map<String, Object> row = jdbc.crossTenantReturning("""
                insert into user_preferences (user_id, kind, key, value, weight, source, scope, expires_at)
                values (:user_id, :kind, :key, cast(:value as jsonb), cast(:weight as numeric), :source, :scope,
                        cast(:expires_at as timestamptz))
                on conflict (user_id, kind, key) do update
                  set value = excluded.value,
                      weight = coalesce(cast(:weight_given as numeric), user_preferences.weight),
                      source = excluded.source,
                      scope = excluded.scope, expires_at = excluded.expires_at, updated_at = now()
                returning id
                """, Json.map("user_id", userId, "kind", kind, "key", key,
                "value", value instanceof String s ? s : Json.write(value),
                "weight", insertWeight,
                "weight_given", weight,
                "source", resolvedSource,
                "scope", scope == null ? "long_term" : scope,
                "expires_at", expiresAt));
        return Json.uuid(row, "id");
    }

    public int updatePreference(TenantContext tenant, UUID userId, UUID id, Object value, Double weight, String scope) {
        requireUserInTenant(tenant, userId);
        return jdbc.updateForTenant(tenant, """
                update user_preferences p
                set value = coalesce(cast(:value as jsonb), value),
                    weight = coalesce(cast(:weight as numeric), weight),
                    scope = coalesce(cast(:scope as text), scope), updated_at = now()
                from users u
                where p.id = :id and p.user_id = :user_id and u.id = :user_id and u.tenant_id = :tenant_id
                """, Json.map("id", id, "user_id", userId,
                "value", value == null ? null : (value instanceof String s ? s : Json.write(value)),
                "weight", weight, "scope", scope));
    }

    public int deletePreference(TenantContext tenant, UUID userId, UUID id) {
        requireUserInTenant(tenant, userId);
        return jdbc.updateForTenant(tenant, """
                delete from user_preferences p using users u
                where p.id = :id and p.user_id = :user_id and u.id = p.user_id and u.tenant_id = :tenant_id
                """, Json.map("id", id, "user_id", userId));
    }

    public int deleteInferredPreferences(TenantContext tenant, UUID userId) {
        requireUserInTenant(tenant, userId);
        return jdbc.updateForTenant(tenant, """
                delete from user_preferences p using users u
                where p.user_id = :user_id and u.id = p.user_id and u.tenant_id = :tenant_id
                  and p.source = 'inferred'
                """, Json.map("user_id", userId));
    }

    /**
     * What one wipe of the caller's whole preference memory took, split by the source column's own labels.
     *
     * @param total     the rows this statement deleted, which is the number the door answers with and files
     * @param bySource  the same rows counted per {@code source}, from the rows the statement returned
     */
    public record PreferenceMemory(int total, Map<String, Integer> bySource) {
    }

    /**
     * §106's "delete memory", the whole of it: every preference row the caller owns, whichever source wrote it.
     *
     * <p>{@link #deleteInferredPreferences} is the narrower act — it keeps what the person typed — so a wipe that
     * claimed to take the memory but left two of the source column's three labels in place would be the same door
     * answering a different question. The split is read out of {@code returning p.source} rather than counted in a
     * second statement first: the numbers then describe the rows this statement actually took, and cannot disagree
     * with the total the ledger row and the response carry.
     */
    public PreferenceMemory deletePreferenceMemory(TenantContext tenant, UUID userId) {
        requireUserInTenant(tenant, userId);
        List<Map<String, Object>> taken = jdbc.forTenant(tenant, """
                delete from user_preferences p using users u
                where p.user_id = :user_id and u.id = p.user_id and u.tenant_id = :tenant_id
                returning p.source as source
                """, Json.map("user_id", userId));
        Map<String, Integer> bySource = new java.util.TreeMap<>();
        for (Map<String, Object> row : taken) {
            bySource.merge(String.valueOf(row.get("source")), 1, Integer::sum);
        }
        return new PreferenceMemory(taken.size(), Map.copyOf(bySource));
    }

    // ---- favorites ------------------------------------------------------

    public List<Map<String, Object>> listFavorites(TenantContext tenant, UUID userId) {
        return jdbc.forTenant(tenant, """
                select f.id, f.subject_type, f.subject_id, f.note, f.created_at, u.tenant_id
                from favorites f join users u on u.id = f.user_id
                where f.user_id = :user_id and u.tenant_id = :tenant_id
                order by f.created_at desc
                """, Json.map("user_id", userId));
    }

    public UUID addFavorite(TenantContext tenant, UUID userId, String subjectType, UUID subjectId, String note) {
        requireUserInTenant(tenant, userId); // favorites has no tenant column of its own
        Map<String, Object> row = jdbc.crossTenantReturning("""
                insert into favorites (user_id, subject_type, subject_id, note)
                values (:user_id, :subject_type, :subject_id, cast(:note as text))
                on conflict (user_id, subject_type, subject_id) do update set note = excluded.note
                returning id
                """, Json.map("user_id", userId, "subject_type", subjectType, "subject_id", subjectId, "note", note));
        return Json.uuid(row, "id");
    }

    public int removeFavorite(TenantContext tenant, UUID userId, String subjectType, UUID subjectId) {
        return jdbc.updateForTenant(tenant, """
                delete from favorites f using users u
                where f.user_id = :user_id and f.subject_type = :subject_type and f.subject_id = :subject_id
                  and u.id = f.user_id and u.tenant_id = :tenant_id
                """, Json.map("user_id", userId, "subject_type", subjectType, "subject_id", subjectId));
    }

    // ---- saved searches -------------------------------------------------

    public List<Map<String, Object>> listSavedSearches(TenantContext tenant, UUID userId) {
        return jdbc.forTenant(tenant, """
                select s.id, s.name, s.query, s.intent, s.notify, s.created_at, u.tenant_id
                from saved_searches s join users u on u.id = s.user_id
                where s.user_id = :user_id and u.tenant_id = :tenant_id
                order by s.created_at desc
                """, Json.map("user_id", userId));
    }

    public UUID saveSearch(TenantContext tenant, UUID userId, String name, String query, Object intent, boolean notify) {
        requireUserInTenant(tenant, userId); // saved_searches has no tenant column of its own
        Map<String, Object> row = jdbc.crossTenantReturning("""
                insert into saved_searches (user_id, name, query, intent, notify)
                values (:user_id, cast(:name as text), :query, cast(:intent as jsonb), :notify)
                returning id
                """, Json.map("user_id", userId, "name", name, "query", query,
                "intent", intent instanceof String s ? s : Json.write(intent), "notify", notify));
        return Json.uuid(row, "id");
    }

    public int deleteSavedSearch(TenantContext tenant, UUID userId, UUID id) {
        return jdbc.updateForTenant(tenant, """
                delete from saved_searches s using users u
                where s.id = :id and s.user_id = :user_id and u.id = s.user_id and u.tenant_id = :tenant_id
                """, Json.map("id", id, "user_id", userId));
    }

    // ---- deletion + export bookkeeping (§106) --------------------------

    /**
     * The four acts §106's request ledger declares it can record.
     *
     * <p>The column's own declaration is a comment in the migration — {@code kind text NOT NULL} with the four
     * spellings after a double dash — so the schema refuses no fifth spelling and nothing in the build ever
     * checked that the four it names are reachable. Declaring them here gives the insert one place to bind from and gives the door census a
     * declaration to walk: a member the vocabulary names that no door files reddens that census instead of living
     * as a sentence in a migration. The text each member carries is the text the DDL comment spells, so the ledger's
     * rows read the same either way.
     */
    public enum DeletionKind {
        ACCOUNT("account"),
        MEMORY("memory"),
        PERSONALIZATION("personalization"),
        EXPORT("export");

        private final String kind;

        DeletionKind(String kind) {
            this.kind = kind;
        }

        /** The text the column holds, and the only text this build files. */
        public String kind() {
            return kind;
        }
    }

    /**
     * The states §106's request ledger can hold, each declaring both halves of its own record.
     *
     * <p>Before this declaration the status was a literal inside the insert's own {@code VALUES} list and
     * {@code completed_at} appeared in no statement at all, so every request the platform filed read
     * {@code 'pending'} with no completion moment — including the ones it had finished inside the same request —
     * and no caller could file anything else. A member here names its status text and whether that text claims a
     * moment; the insert binds both columns from this one declaration, so a row cannot carry a status whose
     * completion column says otherwise.
     */
    public enum DeletionState {
        PENDING("pending", false),
        COMPLETED("completed", true);

        private final String status;
        private final boolean completion;

        DeletionState(String status, boolean completion) {
            this.status = status;
            this.completion = completion;
        }

        public String status() {
            return status;
        }

        /** Whether a row in this state must hold a {@code completed_at}, and the only place that decides it. */
        public boolean carriesCompletion() {
            return completion;
        }
    }

    public UUID createDeletionRequest(TenantContext tenant, UUID userId, DeletionKind kind, DeletionState state,
                                      Map<String, Object> payload) {
        // deletion_requests has no tenant column; the users anchor is verified first.
        requireUserInTenant(tenant, userId);
        jdbc.crossTenantUpdate("""
                insert into deletion_requests (user_id, kind, status, payload, completed_at)
                values (:user_id, :kind, :status, cast(:payload as jsonb),
                        case when cast(:completed as boolean) then now() end)
                """, Json.map("user_id", userId, "kind", kind.kind(), "status", state.status(),
                "completed", state.carriesCompletion(), "payload", Json.write(payload)));
        return userId;
    }

    /** Rows of any tenant-owned table that reference this user — the export payload (§106). */
    public List<Map<String, Object>> exportRows(TenantContext tenant, UUID userId, String sql, int limit) {
        if (!sql.contains("tenant_id")) {
            throw new IllegalStateException("Export query lacks a tenant predicate");
        }
        List<Map<String, Object>> rows = jdbc.forTenant(tenant, sql, Json.map("user_id", userId, "limit", limit));
        rows.forEach(row -> row.replaceAll((column, value) -> portable(row, column)));
        return rows;
    }

    /**
     * A portable file is JSON, so the driver's own objects have to be asked for their values before they
     * reach the response. Two shapes were measured on this route rather than imagined: {@code jsonb} arrives
     * as a {@code PGobject}, which Jackson writes as its three getters — {@code {"type":"jsonb","value":…}}
     * with the real document left as a string inside it — and {@code text[]} arrives as a {@code PgArray}
     * that still holds its result set, whose getters reach {@code PgConnection}, and whose serialization
     * fails the whole export with a 500. {@code Json.json} is the house conversion the rest of the build
     * already uses; the array is unwrapped here because no column this export reads holds jsonb elements.
     */
    private static Object portable(Map<String, Object> row, String column) {
        Object value = row.get(column);
        if (value instanceof org.postgresql.util.PGobject) {
            return Json.json(row, column);
        }
        if (value instanceof java.sql.Array array) {
            try {
                if (!(array.getArray() instanceof Object[] elements)) {
                    return value;
                }
                List<Object> out = new java.util.ArrayList<>(elements.length);
                for (Object element : elements) {
                    out.add(element);
                }
                return out;
            } catch (java.sql.SQLException e) {
                throw ApiException.internal("Failed to read array column " + column, e);
            }
        }
        return value;
    }

    public static int limitOrDefault(Paging paging, String raw) {
        return paging.limit(raw);
    }
}
