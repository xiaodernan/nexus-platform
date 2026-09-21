/**
 * `auth` — registration, login, OAuth, refresh, logout, demo session (contract §3).
 *
 * The access token from any successful auth response is injected back into the
 * client (bearer), so the very next call is authenticated without extra wiring.
 */
import { Resource } from "./_base.js";
import type { AuthSession } from "../types.js";

export interface RegisterInput {
  email: string;
  password: string;
  display_name?: string;
  locale?: string;
  accept_terms?: boolean;
  [key: string]: unknown;
}

export interface LoginInput {
  email: string;
  password: string;
  [key: string]: unknown;
}

export interface OAuthInput {
  id_token: string;
  [key: string]: unknown;
}

export type DemoRole = "consumer" | "merchant" | "admin";

export class AuthResource extends Resource {
  /** `POST /api/v1/auth/register`. */
  async register(input: RegisterInput): Promise<AuthSession> {
    const session = await this.post<AuthSession>("/api/v1/auth/register", input, { auth: false });
    this.capture(session);
    return session;
  }

  /** `POST /api/v1/auth/login`. */
  async login(input: LoginInput): Promise<AuthSession> {
    const session = await this.post<AuthSession>("/api/v1/auth/login", input, { auth: false });
    this.capture(session);
    return session;
  }

  /** `POST /api/v1/auth/oauth/{provider}` (google|apple); provider JWKS verified server-side. */
  async oauth(provider: string, input: OAuthInput): Promise<AuthSession> {
    const session = await this.post<AuthSession>(`/api/v1/auth/oauth/${encodeURIComponent(provider)}`, input, { auth: false });
    this.capture(session);
    return session;
  }

  /** `POST /api/v1/auth/refresh` — rotates the pair and adopts the new access token. */
  async refresh(refreshToken: string): Promise<AuthSession | { access_token: string; refresh_token: string }> {
    const result = await this.post<Partial<AuthSession> & { access_token?: string }>("/api/v1/auth/refresh", { refresh_token: refreshToken }, { auth: false });
    if (typeof result?.access_token === "string") this.http.setToken(result.access_token);
    return result as AuthSession;
  }

  /** `POST /api/v1/auth/logout`. Clears local bearer regardless of server outcome. */
  async logout(): Promise<void> {
    try {
      await this.post("/api/v1/auth/logout", {});
    } finally {
      this.http.setToken(undefined);
    }
  }

  /** `POST /api/v1/auth/demo {role}` — scoped demo session (§87). */
  async demo(role: DemoRole): Promise<AuthSession> {
    const session = await this.post<AuthSession>("/api/v1/auth/demo", { role }, { auth: false });
    this.capture(session);
    return session;
  }

  private capture(session: Partial<AuthSession> | undefined): void {
    if (session && typeof session.access_token === "string") this.http.setToken(session.access_token);
  }
}
