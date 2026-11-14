// Local development simulations retain their disposable operator fixtures.
export const hostedWorkspace = !["localhost", "127.0.0.1", "[::1]"].includes(
  window.location.hostname
);
export const portalSignIn = "https://portal.onesa.eu/admin";
export const portalRegistration = portalSignIn + "?entry=register";
export const portalSecurity = "https://portal.onesa.eu/account/security";
