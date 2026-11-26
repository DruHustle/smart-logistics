import { API_ORIGIN } from "./api-origin";
import { safeLocalStorage, safeSessionStorage } from "./storage";
import { User, AuthResponse, IAuthService } from "./auth-types";
import { hostedWorkspace, workspaceDestination } from "./portal-account";

const TOKEN_KEY = "imsop_token",
  USER_KEY = "imsop_user";
export { resolveApiOrigin as resolveAuthOrigin } from "./api-origin";
const API_BASE = API_ORIGIN;
// The wrapper already provides a memory fallback when browser storage is blocked.
const getStorage = () => safeLocalStorage;

export function browserLogoutDestination(value: unknown, origin: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const client = url.searchParams.get("client_id");
    return url.origin === "https://auth.onesa.eu" && url.pathname === "/oidc/logout" &&
      !url.username && !url.password && !url.hash &&
      Array.from(url.searchParams.keys()).length === 2 &&
      client && /^[\w-]{16,128}$/.test(client) &&
      url.searchParams.get("post_logout_redirect_uri") === origin + "/" ? url.href : null;
  } catch {
    return null;
  }
}

export class ApiAuthService implements IAuthService {
  private async fetchApi(path: string, opts: RequestInit = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...opts,
        signal: controller.signal,
        credentials: "include",
        headers: { "Content-Type": "application/json", ...opts.headers },
      });
      if (res.status === 401 && path === "/api/auth/logout") {
        safeSessionStorage.removeItem("imsop:signout-pending");
        return {};
      }
      if (
        res.status === 401 &&
        !["/api/auth/login", "/api/auth/me", "/api/auth/onesa/start"].includes(
          path
        )
      )
        window.dispatchEvent(new Event("imsop:session-expired"));
      if (!res.ok)
        throw new Error(
          (await res.json().catch(() => ({}))).error || "API failed"
        );
      if (res.status === 204) return {};
      if (
        !(res.headers?.get("Content-Type") ?? "application/json").includes(
          "application/json"
        )
      )
        throw new Error(
          "The server returned an unexpected response. Please retry."
        );
      return await res.json();
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          "The server took too long to respond. Please try again."
        );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  async onesaEntry(): Promise<{enabled:boolean;signup:boolean}> {
    const config = await this.fetchApi("/api/auth/onesa/config");
    return {enabled:config.enabled === true,signup:config.signup === true};
  }
  async startOnesa(
    link?: { email: string; password: string },
    destination?: string,
    signup = false,
  ): Promise<void> {
    if (safeSessionStorage.getItem("imsop:signout-pending"))
      await this.logout(false);
    const current = destination ?? window.location.hash;
    const retry = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("returnTo");
    const returnTo = workspaceDestination(current) ?? workspaceDestination(retry) ??
      workspaceDestination(safeSessionStorage.getItem("imsop:return-to")) ?? "#/";
    const { url } = await this.fetchApi("/api/auth/onesa/start", {
      method: "POST",
      body: JSON.stringify({
        ...(link ? { link } : {}),
        ...(signup ? { signup:true } : {}),
        returnTo,
      }),
    });
    const issuer = new URL(url);
    if (issuer.protocol !== "https:")
      throw Error("Invalid Onesa sign-in destination.");
    getStorage().removeItem(TOKEN_KEY);
    getStorage().removeItem(USER_KEY);
    window.location.assign(issuer.href);
  }
  async login(email: string, password: string): Promise<AuthResponse> {
    try {
      if (safeSessionStorage.getItem("imsop:signout-pending"))
        await this.logout(false);
      const { user } = await this.fetchApi("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      const s = getStorage();
      s.removeItem(TOKEN_KEY);
      s.setItem(USER_KEY, JSON.stringify(user));
      return { success: true, user };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
  logout = async (endSharedSession = true) => {
    safeSessionStorage.setItem("imsop:signout-pending", "true");
    [TOKEN_KEY, USER_KEY].forEach(k => getStorage().removeItem(k));
    const { sharedLogout } = await this.fetchApi("/api/auth/logout", { method: "POST" });
    safeSessionStorage.removeItem("imsop:signout-pending");
    if (endSharedSession) {
      const url = browserLogoutDestination(sharedLogout, window.location.origin);
      if (url) window.location.assign(url);
    }
  };
  async getCurrentUser(): Promise<AuthResponse> {
    if (safeSessionStorage.getItem("imsop:signout-pending"))
      return {
        success: false,
        error:
          "Sign out was not confirmed. Sign in retries it before continuing.",
      };
    const t = getStorage().getItem(TOKEN_KEY);
    if (t?.startsWith("mock_")) return { success: false };
    try {
      const sessionPath = hostedWorkspace ? "/api/auth/session-state" : "/api/auth/me";
      const { user } = await this.fetchApi(sessionPath);
      return user ? { success: true, user } : { success: false };
    } catch {
      return { success: false };
    }
  }
  register = async (email: string, password: string, name: string) =>
    this.wrap(() =>
      this.fetchApi("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
      })
    );
  requestPasswordReset = async (email: string) =>
    this.wrap(() =>
      this.fetchApi("/api/auth/request-reset", {
        method: "POST",
        body: JSON.stringify({ email }),
      })
    );
  resetPassword = async (token: string, newPassword: string) =>
    this.wrap(() =>
      this.fetchApi("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword }),
      })
    );
  updateProfile = async (id: string, updates: any) =>
    this.wrap(() =>
      this.fetchApi(`/api/auth/profile/${id}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      })
    );
  changePassword = async (
    id: string,
    currentPassword: string,
    newPassword: string
  ) =>
    this.wrap(() =>
      this.fetchApi(`/api/auth/change-password/${id}`, {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      })
    );
  private async wrap(fn: () => Promise<any>): Promise<AuthResponse> {
    try {
      const res = await fn();
      return { success: true, ...res };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
}
export const apiAuthService = new ApiAuthService();
