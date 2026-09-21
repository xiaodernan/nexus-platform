/**
 * Auth, session, user profile and personal-memory types.
 *
 * Contract: API_CONTRACT §3 (register/login/oauth/refresh/logout, `/me`, preferences, favorites,
 * saved searches, notifications), §1 (Bearer JWT **or** `nexus_session` HttpOnly cookie,
 * `X-CSRF-Token` for state-changing cookie requests), §0 (who owns what).
 * Design: DECISIONS D5 (stateless HS256 dev / RS256 prod, 15m access, 30d rotating refresh).
 * Tables: V1 `users` (29-47), `user_identities` (49-58), `user_preferences` (61-76),
 * `favorites` (616-624), `saved_searches` (626-634), `deletion_requests` (949-957).
 * Spec: §31 Consumer Account, §32 Preference Memory, §33 Personalization, §106 Privacy, §117-§118 Memory.
 */

import type { IdentityProvider, PermissionName, UserRole, UserStatus } from "./enums.js";
import type { ContactInfo, IsoDateTime, Locale, Nullable, Slug, Timestamps, Uuid } from "./common.js";

/** `users.role` — V1 line 38. */
/* enum unions used below are declared in enums.ts */

/**
 * JWT claim set. **Source: API_CONTRACT §3 "JWT claims: `sub, tid (tenant), typ(access|refresh),
 * sid, jti, iat, exp`"** plus registered `iss`/`aud`.
 * Access tokens live 15 minutes, refresh 30 days with rotation + reuse detection (§3, D5).
 */
export interface JwtClaims {
  /** Subject — `users.id`. */
  sub: Uuid;
  /** Tenant id — API §3 "tid (tenant)", mirrored by the `X-Tenant` header (API §1). */
  tid: Uuid;
  /** Token class. */
  typ: "access" | "refresh";
  /** Session id, ties to the `nexus_session` cookie and `audit_logs` — API §3. */
  sid: Uuid;
  /** Unique token id, used for revocation/rotation — API §3. */
  jti: Uuid;
  /** Issued-at, seconds since epoch — API §3. */
  iat: number;
  /** Expiry, seconds since epoch — API §3. */
  exp: number;
  /** Issuer, e.g. `nexus-platform`. */
  iss?: string;
  /** Audience, e.g. `nexus-web`. */
  aud?: string;
  /** Platform role carried for admin route guards (API §9 `role IN (platform_admin, platform_ops)`). */
  role?: UserRole;
  /** Merchant memberships this token may act on, when the caller is a merchant user. */
  mids?: Uuid[];
  /** Scopes when the token stands for an API key / external principal (API §10). */
  scopes?: string[];
}

/**
 * An issued session. **Source: API_CONTRACT §3** — `/auth/register`, `/auth/login`,
 * `/auth/refresh` all return `{user, access_token, refresh_token}`.
 */
export interface AuthSession {
  /** Authenticated user. */
  user: User;
  /** Short-lived bearer token (15m) — API §3. */
  access_token: string;
  /** Rotating refresh token (30d) — API §3. */
  refresh_token: string;
  /** `expires_in` seconds for the access token. */
  expires_in: number;
  /** Token type; always `Bearer` in v1. */
  token_type: "Bearer";
  /** Session id — `sid` claim, also set in the HttpOnly cookie. */
  session_id: Uuid;
  /** CSRF token required on state-changing cookie requests — API §1. */
  csrf_token?: string | null;
  /** Tenant the session is bound to — API §1 `X-Tenant`. */
  tenant?: string | null;
  /** Demo session marker — `POST /api/v1/auth/demo` (API §3, DECISIONS D4/D6); must be shown in the UI. */
  demo?: boolean;
  /** Roles/scopes actually granted, for client-side navigation gating. */
  permissions?: PermissionName[];
}

/** `POST /api/v1/auth/demo` body. Source: API_CONTRACT §3 (spec §87 Demo Environment). */
export interface DemoLoginRequest {
  /** Which demo persona to assume — API §3 `role: consumer|merchant|admin`. */
  role: "consumer" | "merchant" | "admin";
}

/** `POST /api/v1/auth/register` body. Source: API_CONTRACT §3; passwords are Argon2id-hashed server-side. */
export interface RegisterRequest {
  /** Email (V1 `citext`). */
  email: string;
  /** Plaintext over TLS only; never logged or stored (spec §131). */
  password: string;
  /** Display name — V1 `display_name`. */
  display_name: string;
  /** UI locale — V1 `locale` default `zh-HK` (AGENT §12). */
  locale: Locale;
  /** Terms acceptance is an explicit claim, not a default (spec §128 legal/compliance). */
  accept_terms: boolean;
  /** Optional phone for reservation contact — V1 `phone`. */
  phone?: string | null;
  /** Referral code entered at sign-up — V1 `referrals.code` (spec §62). */
  referral_code?: string | null;
}

/** `POST /api/v1/auth/login` body (API_CONTRACT §3). */
export interface LoginRequest {
  /** Account email. */
  email: string;
  /** Password. */
  password: string;
}

/** `POST /api/v1/auth/oauth/{provider}` body (API_CONTRACT §3) — `id_token` verified against the provider JWKS. */
export interface OAuthLoginRequest {
  /** Provider id token — never stored; only `provider_id` (subject) is persisted (V1 `user_identities.provider_id`). */
  id_token: string;
  /** PKCE verifier when the flow started in the browser. */
  code_verifier?: string | null;
  /** Redirect the session should return to. */
  redirect_to?: string | null;
}

/** `POST /api/v1/auth/refresh` body (API_CONTRACT §3, rotation + reuse detection). */
export interface RefreshRequest {
  /** Previous refresh token. */
  refresh_token: string;
}

/**
 * A platform user row. **Source: API_CONTRACT §3 (`GET /api/v1/me`)**, V1 `users` (29-45).
 * `email`/`phone` are nullable because OAuth-only and deletion-anonymised rows may have neither
 * (V1 line 33-34 + the partial unique index at line 46).
 */
export interface User extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id` (nullable on the table: platform staff may be cross-tenant). */
  tenant_id: Uuid | null;
  /** Email; null for pure-OAuth or anonymised accounts — V1 `email`. */
  email: string | null;
  /** Phone — V1 `phone`. */
  phone: string | null;
  /** Display name; null until the user sets one — V1 `display_name`. */
  display_name: string | null;
  /** Avatar URL — V1 `avatar_url`. */
  avatar_url: string | null;
  /** Preferred locale — V1 `locale`. */
  locale: Locale;
  /** Platform role — V1 `role`. */
  role: UserRole;
  /** Account state — V1 `status`. */
  status: UserStatus;
  /** Marketing consent, explicit and revocable — V1 `marketing_opt_in`, spec §123/§128. */
  marketing_opt_in: boolean;
  /** Last successful login — V1 `last_login_at`. */
  last_login_at: IsoDateTime | null;
  /** Soft-delete instant; drives `/me/export` + `deletion_requests` — V1 `deleted_at`, spec §106. */
  deleted_at: IsoDateTime | null;
  /** Linked providers (password/google/apple) — V1 `user_identities`. */
  identities?: IdentityProvider[];
  /** Merchant memberships with roles — V1 `merchant_users`, API §5, spec §48. */
  memberships?: MerchantMembershipSummary[];
  /** Preference summary (`GET /me` returns "profile + memberships + preferences summary") — API §3. */
  preferences_summary?: PreferenceSummary | null;
}

/** Merchant membership summary embedded in `GET /api/v1/me` (API_CONTRACT §3, spec §48). */
export interface MerchantMembershipSummary {
  /** Membership row — V1 `merchant_users.id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_users.merchant_id`. */
  merchant_id: Uuid;
  /** Merchant slug for links — V1 `merchants.slug`. */
  merchant_slug: Slug | null;
  /** Merchant display name — V1 `merchants.display_name`. */
  merchant_name: string | null;
  /** Role within that merchant — V1 `merchant_users.role`. */
  role: string;
  /** Membership state — V1 `merchant_users.status`. */
  status: string;
  /** Effective permissions after `permission_grants` resolution — AGENT §8. */
  permissions: PermissionName[];
}

/**
 * A preference / memory row. **Source: API_CONTRACT §3**
 * (`/api/v1/me/preferences` — "user-visible, editable, deletable (§32-33)"), V1
 * `user_preferences` (61-76). The table has no `tenant_id` column, so the field is optional and
 * only carried when the row travels between services.
 */
export interface UserPreference extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Owner — V1 `user_id`. */
  user_id: Uuid;
  /** Memory kind — V1 `kind` (`food|budget|location|brand|style|activity|language|accessibility`). */
  kind: string;
  /** Stable key, e.g. `cuisine_dislike` — V1 `key`. */
  key: string;
  /** Structured value, e.g. `{"values":["spicy"]}` — V1 `value jsonb`. */
  value: unknown;
  /**
   * Confidence 0..1 — V1 `weight numeric(4,3) DEFAULT 0.500`.
   * `inferred` rows must stay below the hedge band until confirmed (AGENT §4, spec §33).
   */
  weight: number;
  /** Provenance — V1 `source` (`declared|inferred|transaction`). */
  source: string;
  /** Memory tier — V1 `scope` (`session|long_term`), spec §117. */
  scope: string;
  /** Conversation that produced it — V1 `conversation_id`. */
  conversation_id: Uuid | null;
  /** Inferred memory may expire; declared memory does not — V1 `expires_at`, spec §33. */
  expires_at: IsoDateTime | null;
}

/** `POST/PATCH /api/v1/me/preferences` body (API_CONTRACT §3). */
export interface PreferenceInput {
  /** @see UserPreference.kind */
  kind: string;
  /** @see UserPreference.key */
  key: string;
  /** @see UserPreference.value */
  value: unknown;
  /** Declared by the user vs. inferred — only `declared` may be created via this endpoint (spec §32). */
  source?: "declared" | "inferred" | "transaction";
  /** @see UserPreference.scope */
  scope?: "session" | "long_term";
  /** Optional expiry for session memory — V1 `expires_at`. */
  expires_at?: IsoDateTime | null;
}

/** Aggregated preference view embedded in `GET /me` (API_CONTRACT §3). */
export interface PreferenceSummary {
  /** Rows the user can see/edit/delete — API §3. */
  items: UserPreference[];
  /** Count of inferred rows, drives the 「重置 AI 记忆」 affordance — API §3 `/personalization/reset`. */
  inferred_count: number;
  /** Whether personalisation is switched off for this user (spec §33 honesty). */
  personalization_disabled: boolean;
}

/** A favorite row. Source: API_CONTRACT §3 (`/me/favorites`), V1 `favorites` (616-624). */
export interface Favorite {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Owner — V1 `user_id`. */
  user_id: Uuid;
  /** `merchant|offering|guide|collection` — V1 `subject_type`. */
  subject_type: string;
  /** Target id — V1 `subject_id`. */
  subject_id: Uuid;
  /** Personal note — V1 `note`. */
  note: string | null;
  /** Creation instant — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** `POST /api/v1/me/favorites` body (API_CONTRACT §3). */
export interface FavoriteInput {
  /** @see Favorite.subject_type */
  subject_type: string;
  /** @see Favorite.subject_id */
  subject_id: Uuid;
  /** @see Favorite.note */
  note?: string | null;
}

/** A saved search. Source: API_CONTRACT §3 (`/me/saved-searches`), V1 `saved_searches` (626-634). */
export interface SavedSearch {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Owner — V1 `user_id`. */
  user_id: Uuid;
  /** Optional label — V1 `name`. */
  name: string | null;
  /** Raw query text — V1 `query`. */
  query: string;
  /** Frozen intent so re-running is deterministic — V1 `intent jsonb`. */
  intent: Record<string, unknown>;
  /** Notify on new matches — V1 `notify`, spec §59. */
  notify: boolean;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** A `deletion_requests` row (API_CONTRACT §3 `DELETE /me` → "creates deletion_request"), V1 949-957, spec §106. */
export interface DeletionRequest {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Subject user — V1 `user_id`. */
  user_id: Uuid | null;
  /** `account|memory|personalization|export` — V1 `kind`. */
  kind: string;
  /** `pending|in_progress|completed|failed` — V1 `status` default `pending`. */
  status: string;
  /** Snapshot of what will be removed — V1 `payload jsonb`. */
  payload: Record<string, unknown>;
  /** Completion instant — V1 `completed_at`. */
  completed_at: IsoDateTime | null;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** Streaming body of `GET /api/v1/me/export` (API_CONTRACT §3, spec §106 portability). */
export interface PersonalDataExport {
  /** Exported user id. */
  user_id: Uuid;
  /** Export instant. */
  exported_at: IsoDateTime;
  /** Contact snapshot — V1 `users` fields. */
  profile: Nullable<Pick<User, "email" | "phone" | "display_name" | "locale">>;
  /** Preferences — V1 `user_preferences`. */
  preferences: UserPreference[];
  /** Favorites — V1 `favorites`. */
  favorites: Favorite[];
  /** Saved searches — V1 `saved_searches`. */
  saved_searches: SavedSearch[];
  /** Conversations + messages — V1 `conversations`/`messages`. */
  conversations: unknown[];
  /** Orders and reservations — V1 `orders`/`reservations`. */
  commerce: unknown[];
  /** Events attributed to the user — V1 `events`. */
  events: unknown[];
  /** Anything the tenant config keeps about the user. */
  extra: Record<string, unknown>;
}

/** Notification row. **Source: API_CONTRACT §3** (`/api/v1/notifications`), V1 `notifications`
 * (783-798); spec §123 channels, §124 merchant, §125 consumer templates.
 */
export interface Notification {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** `consumer|merchant|platform` — V1 `audience`. */
  audience: string;
  /** Recipient — V1 `user_id`. */
  user_id: Uuid | null;
  /** Recipient merchant — V1 `merchant_id`. */
  merchant_id: Uuid | null;
  /** `in_app|email|push|whatsapp` — V1 `channel` (spec §123). */
  channel: string;
  /** Template id, e.g. `reservation_confirmed`, `new_enquiry`, `merchant_reply` — V1 `template` (spec §124/§125). */
  template: string;
  /** Render variables — V1 `payload jsonb`. */
  payload: Record<string, unknown>;
  /** `pending|sent|failed|suppressed` — V1 `status`. */
  status: string;
  /** Read time; null = unread — V1 `read_at`, API §3 `POST /notifications/{id}/read`. */
  read_at: IsoDateTime | null;
  /** Sent time — V1 `sent_at`. */
  sent_at: IsoDateTime | null;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
  /** Localised title resolved from the template; null before rendering. */
  title?: string | null;
  /** Localised body. */
  body?: string | null;
  /** Deep link for the in-app renderer. */
  link?: string | null;
}

/** Contact/profile edit for `PATCH /api/v1/me` (API_CONTRACT §3). */
export interface UserProfilePatch {
  /** @see User.display_name */
  display_name?: string;
  /** @see User.avatar_url */
  avatar_url?: string | null;
  /** @see User.locale */
  locale?: Locale;
  /** @see User.phone */
  phone?: string | null;
  /** @see User.marketing_opt_in */
  marketing_opt_in?: boolean;
  /** Structured contact block — V1 `merchants.contact` shape reused for user contact (API §3). */
  contact?: ContactInfo;
}
