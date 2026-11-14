import { expect, test } from "@playwright/test";
import { isolate, loginDemo, navigate } from "./helpers";
test.beforeEach(async ({ page }) => isolate(page));
test("auth links and reset token handling survive the shell redesign", async ({
  page,
}) => {
  await page.goto("/#/login");
  await expect(
    page.getByRole("heading", { name: "Welcome to Smart Logistics" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/#\/forgot-password/);
  await page.goto("/?token=synthetic.reset.token#/reset-password");
  await expect(page.getByLabel("New Password", { exact: true })).toBeVisible();
  await page.goto("/#/register");
  await expect(
    page.getByText("Create an Account", { exact: true })
  ).toBeVisible();
  await page.getByRole("link", { name: "Sign In" }).click();
  await expect(page).toHaveURL(/#\/login/);
});
test("pointer navigation opens the shipment workspace and drawer closes", async ({
  page,
}) => {
  await loginDemo(page);
  await navigate(page, "Shipments");
  await expect(
    page.getByRole("heading", { name: "Shipments", exact: true })
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/supply-chain\/shipments/);
});

for (const [route, purpose] of [
  ["/#/login", "current-password"],
  ["/#/register", "new-password"],
  ["/?token=synthetic.reset.token#/reset-password", "new-password"],
] as const) {
  test(`password visibility accepts edge taps and keyboard input on ${route}`, async ({
    page,
  }) => {
    await page.goto(route);
    const password = page.locator("#password");
    await expect(password).toHaveAttribute("autocomplete", purpose);
    const toggle = page.getByRole("button", {
      name: "Show password",
      exact: true,
    });
    // Wait for the card entrance animation before measuring the hit area.
    await toggle.click({ trial: true });
    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await toggle.click({ position: { x: box!.width - 4, y: box!.height / 2 } });
    await expect(password).toHaveAttribute("type", "text");
    const hide = page.getByRole("button", {
      name: "Hide password",
      exact: true,
    });
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    await hide.focus();
    await page.keyboard.press("Space");
    await expect(password).toHaveAttribute("type", "password");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    if (route.includes("reset-password")) {
      await expect(page.locator("#confirmPassword")).toHaveAttribute(
        "autocomplete",
        "new-password"
      );
    } else {
      await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute(
        "autocomplete",
        "email"
      );
    }
  });
}

test("hosted login offers Portal account access during an issuer outage", async ({
  page,
  baseURL,
}) => {
  const hosted = "https://logistics.example.invalid";
  await page.route(hosted + "/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      return route.fulfill({
        status: 503,
        json: { error: "Service unavailable" },
      });
    }
    const asset = await page.request.get(
      new URL(url.pathname + url.search, baseURL).href
    );
    await route.fulfill({ response: asset });
  });
  await page.route("https://portal.onesa.eu/**", route =>
    route.fulfill({ contentType: "text/html", body: "<title>Portal</title>" })
  );

  await page.goto(hosted + "/#/login");
  const portal = page
    .getByRole("status")
    .getByRole("link", { name: "Company Portal" });
  await expect(portal).toHaveAttribute("href", "https://portal.onesa.eu/admin");
  await portal.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("https://portal.onesa.eu/admin");

  await page.goto(hosted + "/#/login");
  await page.getByRole("button", { name: "Sign Up", exact: true }).click();
  await expect(page).toHaveURL("https://portal.onesa.eu/admin?entry=register");
  for (const [route, destination] of [
    ["/register", "/admin?entry=register"],
    ["/forgot-password", "/account/security"],
  ]) {
    await page.goto(hosted + "/#" + route);
    await expect(page).toHaveURL("https://portal.onesa.eu" + destination);
  }
});
