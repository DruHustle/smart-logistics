import { safeSessionStorage } from "./storage";
// Local development simulations retain their disposable operator fixtures.
export const hostedWorkspace = !["localhost", "127.0.0.1", "[::1]"].includes(
  window.location.hostname
);
export const portalSignIn = "https://portal.onesa.eu/admin";
export const portalRegistration = "https://auth.onesa.eu/register?audience=user&product=logistics&platform=web";
export const portalSecurity = "https://portal.onesa.eu/account/security";

const registrationKey = "onesa.product-registration";

export function rememberRegistration() {
  const hash = window.location.hash;
  const query = new URLSearchParams(hash.split("?")[1] || "");
  const requested = query.get("returnTo") || safeSessionStorage.getItem("imsop:return-to") || hash;
  const route = requested.startsWith("#/") && !requested.startsWith("#//") &&
    !/[\\\u0000-\u0020]/.test(requested) && requested.length <= 2048 &&
    !/^#\/(login|register|reset-password|forgot-password)(?:[/?#]|$)/.test(requested) ? requested : "#/";
  safeSessionStorage.setItem(registrationKey, route);
}

export function resumeRegistration() {
  if (window.location.hash !== "#/login?registration=complete") return false;
  const route = safeSessionStorage.getItem(registrationKey);
  safeSessionStorage.removeItem(registrationKey);
  if (!route) return false;
  safeSessionStorage.setItem("imsop:return-to", route);
  history.replaceState(null, "", "#/login?returnTo=" + encodeURIComponent(route));
  return true;
}
