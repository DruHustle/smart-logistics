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

test("hosted login fails closed without Portal fallback during an issuer outage", async ({
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
  await page.route("https://account.onesa.eu/**", route => route.fulfill({contentType:"text/html", body:"<title>Identity</title>"}));
  await page.route("https://portal.onesa.eu/**", route =>
    route.fulfill({ contentType: "text/html", body: "<title>Portal</title>" })
  );

  await page.goto(hosted + "/#/login");
  // A failed issuer never authorizes the unrelated Portal admin entry.
  // Recovery is retrying the real issuer, not redirecting to weaker credentials.
  await expect(page.getByRole("button", { name: "Retry Onesa sign-in" })).toBeVisible();
  await expect(page.getByRole("status").getByRole("link", { name: "Company Portal" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry Onesa sign-in" }).click();
  await expect(page.getByRole("button", { name: "Retry Onesa sign-in" })).toBeVisible();
  await expect(page).toHaveURL(hosted + "/#/login");

  await page.goto(hosted + "/#/login");
  await page.getByRole("button", { name: "Sign Up", exact: true }).click();
  await expect(page).toHaveURL("https://account.onesa.eu/register?audience=user&product=logistics&platform=web");
  const user = "https://account.onesa.eu/register?audience=user&product=logistics&platform=web";
  const admin = "https://account.onesa.eu/register?audience=admin&product=logistics&platform=web";
  await page.goto(hosted + "/#/register");
  await expect(page.getByRole("heading", {name:"Create your Onesa account"})).toBeVisible();
  await expect(page.getByRole("link", {name:"Register as a user"})).toHaveAttribute("href", user);
  await expect(page.getByRole("link", {name:"Request administrator access"})).toHaveAttribute("href", admin);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole("link", {name:"Request administrator access"}).click();
  await expect(page).toHaveURL(admin);

  await page.goto(hosted + "/#/forgot-password");
  await expect(page.getByRole("heading", {name:"Recover your Onesa account"})).toBeVisible();
  await page.getByRole("link", {name:"Open Onesa sign-in"}).click();
  await expect(page).toHaveURL("https://account.onesa.eu/login");

  // Legacy product reset tokens must not be forwarded to a central IdP.
  await page.goto(hosted + "/#/reset-password?token=synthetic.private.value");
  await expect(page).toHaveURL("https://account.onesa.eu/login");
});

test("a hosted visitor filters synthetic shipments and opens Onesa at the selected feature", async ({
  page, baseURL,
}) => {
  const hosted = "https://logistics.example.invalid";
  const apiRequests: string[] = [];
  await page.route(hosted + "/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) apiRequests.push(url.pathname);
    if (url.pathname === "/api/auth/session-state")
      return route.fulfill({ json: { user: null } });
    if (url.pathname === "/api/auth/onesa/config")
      return route.fulfill({ json: { enabled: true } });
    if (url.pathname === "/api/auth/onesa/start") {
      expect(route.request().postDataJSON()).toEqual({
        returnTo: "#/supply-chain/shipments?status=Delayed",
      });
      return route.fulfill({ json: { url: "https://identity.example.test/authorize" } });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 401 });
    return route.fulfill({
      response: await page.request.get(new URL(url.pathname + url.search, baseURL).href),
    });
  });
  await page.route("https://identity.example.test/authorize", route =>
    route.fulfill({ body: "Onesa sign-in" })
  );

  await page.goto(hosted);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Explore Smart Logistics");
  for (const name of [
    "Operational overview",
    "Shipment tracking",
    "Order management",
    "Logistics analytics",
    "Exception review",
    "Logistics assistant",
  ]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Sign in for ${name.toLowerCase()}` })).toBeVisible();
  }
  await expect(page.getByText("Demo accounts", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.getByText("Explore with sample data", { exact: true }).click();
  const sampleTable = page.getByRole("table", { name: "Sample shipment tracking" });
  await expect(sampleTable.getByRole("row", { name: /SHP-9921/ })).toBeVisible();
  await expect(sampleTable.getByRole("row", { name: /SHP-7732/ })).toBeVisible();
  await page.getByLabel("Shipment status").selectOption("Delayed");
  await expect(sampleTable.getByRole("row", { name: /SHP-9921/ })).toBeVisible();
  await expect(sampleTable.getByRole("row", { name: /SHP-7732/ })).toHaveCount(0);

  await expect.poll(() => [...apiRequests].sort()).toEqual([
    "/api/auth/onesa/config", "/api/auth/session-state",
  ]);
  await page.getByRole("button", { name: "Sign in for shipment tracking" }).click();
  await expect(page).toHaveURL("https://identity.example.test/authorize");
});

test("hosted Logistics discards a previous browser demo session on an administrative route", async ({
  page, baseURL,
}) => {
  const hosted = "https://logistics.example.invalid";
  await page.addInitScript(() => {
    localStorage.setItem("imsop_token", "mock_retained");
    localStorage.setItem("imsop_session", JSON.stringify({
      id: "1", name: "Admin User", email: "admin@imsop.io", role: "admin",
    }));
  });
  const apiRequests: string[] = [];
  await page.route(hosted + "/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) apiRequests.push(url.pathname);
    if (url.pathname === "/api/auth/session-state")
      return route.fulfill({ json: { user: null } });
    if (url.pathname === "/api/auth/onesa/config")
      return route.fulfill({ json: { enabled: true } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 401 });
    return route.fulfill({
      response: await page.request.get(new URL(url.pathname + url.search, baseURL).href),
    });
  });

  await page.goto(hosted + "/#/infrastructure/health");
  await expect(page.getByRole("button", { name: "Sign in with Onesa", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Service health", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("imsop_token"))).toBeNull();
  await expect.poll(() => [...apiRequests].sort()).toEqual([
    "/api/auth/onesa/config", "/api/auth/session-state",
  ]);
});

for (const audience of ["user", "admin"]) {
  test("Identity returns a Logistics " + audience + " to the tracked shipment", async ({page,baseURL})=>{
    const hosted="https://logistics.example.invalid";
    await page.route(hosted+"/**",async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==="/api/auth/onesa/config") return route.fulfill({json:{enabled:true}});
      if(url.pathname==="/api/auth/onesa/start"){
        expect(route.request().postDataJSON()).toEqual({returnTo:"#/supply-chain/shipments/123/tracking"});
        return route.fulfill({json:{url:"https://identity.example.test/authorize"}});
      }
      if(url.pathname.startsWith("/api/")) return route.fulfill({status:401,json:{}});
      const asset=await page.request.get(new URL(url.pathname+url.search,baseURL).href);
      return route.fulfill({response:asset});
    });
    await page.route("https://account.onesa.eu/**",route=>route.fulfill({contentType:"text/html",body:'<a href="'+hosted+'/#/login?registration=complete">Back to Logistics</a>'}));
    await page.route("https://identity.example.test/authorize",route=>route.fulfill({body:"Onesa sign-in"}));
    await page.goto(hosted+"/#/login?returnTo="+encodeURIComponent("#/supply-chain/shipments/123/tracking"));
    const entry = audience === "admin"
      ? page.getByRole("link", {name: "Request administrator access"})
      : page.getByRole("button", {name: "Sign Up", exact: true});
    await entry.click();
    await expect(page).toHaveURL("https://account.onesa.eu/register?audience="+audience+"&product=logistics&platform=web");
    await page.getByRole("link",{name:"Back to Logistics"}).click();
    await expect(page).toHaveURL("https://identity.example.test/authorize");
  });
}
