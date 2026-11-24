import { safeSessionStorage } from "./storage";
// Local development simulations retain their disposable operator fixtures.
export const hostedWorkspace = !["localhost", "127.0.0.1", "[::1]"].includes(
  window.location.hostname
);
export const portalSignIn = "https://portal.onesa.eu/admin";
export function identityRegistration(audience: "user" | "admin") {
  return "https://account.onesa.eu/register?audience=" + audience + "&product=logistics&platform=web";
}
export const portalSecurity = "https://portal.onesa.eu/account/security";
// Account recovery starts at the central managed sign-in screen.
// /account/recovery is a protected POST action, not a public GET page.
export const identityRecovery = "https://account.onesa.eu/login";

const registrationKey = "onesa.product-registration";

export function workspaceDestination(value: unknown): string | null {
  return typeof value === "string" && value.length <= 2048 &&
    /^#\/(?!\/)/.test(value) && !/[\\\u0000-\u0020\u007f]/.test(value) &&
    !/^#\/(login|register|reset-password|forgot-password)(?:[/?#]|$)/.test(value)
      ? value : null;
}

export function rememberRegistration() {
  const hash = window.location.hash;
  const query = new URLSearchParams(hash.split("?")[1] || "");
  const requested = query.get("returnTo") || safeSessionStorage.getItem("imsop:return-to") || hash;
  safeSessionStorage.setItem(registrationKey, workspaceDestination(requested) ?? "#/");
}

export function resumeRegistration() {
  if (window.location.hash !== "#/login?registration=complete") return false;
  const route = workspaceDestination(safeSessionStorage.getItem(registrationKey)) ?? "#/";
  safeSessionStorage.removeItem(registrationKey);
  safeSessionStorage.setItem("imsop:return-to", route);
  history.replaceState(null, "", "#/login?returnTo=" + encodeURIComponent(route));
  return true;
}
