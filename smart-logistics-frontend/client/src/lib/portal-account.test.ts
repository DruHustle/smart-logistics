import { describe, expect, it } from "vitest";
import { identityRecovery, identityRegistration } from "./portal-account";

describe("Onesa Account hosted entrypoints", () => {
  it.each(["user", "admin"] as const)("binds %s registration to Logistics web", (tier) => {
    const url = new URL(identityRegistration(tier));
    expect(url.origin).toBe("https://account.onesa.eu");
    expect(url.pathname).toBe("/register");
    expect([...url.searchParams.entries()]).toEqual([
      ["audience", tier], ["product", "logistics"], ["platform", "web"],
    ]);
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(url.hash).toBe("");
  });

  it("uses the public managed sign-in screen for password recovery, not a protected POST route", () => {
    const url = new URL(identityRecovery);
    expect(url.origin).toBe("https://account.onesa.eu");
    expect(url.pathname).toBe("/login");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });
});
