import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  currentApiOrigin, currentWebOrigin, prepareDeployment, httpsOrigin,
  prepareStagingDeployment, stagingApiOrigin, stagingWebOrigin,
} from "./prepare-deployment.mjs";

const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const html = await readFile(new URL("../client/index.html", import.meta.url), "utf8");

test("production defaults and first-party proxy routes use the canonical Logistics API", async () => {
  assert.equal(currentApiOrigin, "https://logistics-api.onesa.eu");
  const environment = await readFile(new URL("../.env.production", import.meta.url), "utf8");
  assert.deepEqual(
    environment.split(/\r?\n/).filter(line => line.startsWith("VITE_API_URL=")),
    ["VITE_API_URL=" + currentApiOrigin]
  );
  for (const pathname of ["/version", "/api/:path*", "/supply-chain/:path*", "/health", "/ready"]) {
    assert.equal(config.rewrites.find(route => route.source === pathname)?.destination,
      currentApiOrigin + pathname);
  }
});

test("domain migration moves every authenticated and readiness path before the SPA fallback", () => {
  const original = structuredClone(config);
  const prepared = prepareDeployment(config, html, "https://qualified-api.example/", "https://logistics.onesa.eu/");
  const routes = prepared.config.rewrites;
  const spa = routes.findIndex(route => route.destination === "/index.html");
  for (const pathname of ["/version", "/api/:path*", "/supply-chain/:path*", "/health", "/ready"]) {
    const index = routes.findIndex(route => route.source === pathname);
    assert(index >= 0 && index < spa);
    assert.equal(routes[index].destination, "https://qualified-api.example" + pathname);
  }
  assert.deepEqual(prepared.config.headers, config.headers);
  assert.deepEqual(prepared.config.git, config.git);
  assert.match(prepared.html, /rel="canonical" href="https:\/\/logistics.onesa.eu\/"/);
  assert(!prepared.html.includes("imsop-app.vercel.app"));
  assert.deepEqual(config, original, "The source configuration must not be mutated");
});

test("bad origins and an incomplete proxy fail before configuration is written", () => {
  for (const origin of ["http://api.example", "https://api.example/api", "https://user:password@api.example", "https://api.example/?x=1", "https://api.example/#bad", "https://api.example;bad"]) {
    assert.throws(() => httpsOrigin(origin, "test"));
  }
  const broken = structuredClone(config);
  broken.rewrites = broken.rewrites.filter(route => route.source !== "/supply-chain/:path*");
  assert.throws(() => prepareDeployment(broken, html, "https://logistics-api.onesa.eu", "https://logistics.onesa.eu"), /supply-chain/);
});

test("staging binds every API route to the isolated origin and disables Git deployment", () => {
  const original = structuredClone(config);
  const prepared = prepareStagingDeployment(config, html, stagingApiOrigin, stagingWebOrigin);
  const routes = prepared.config.rewrites;
  const spa = routes.findIndex(route => route.destination === "/index.html");
  for (const pathname of ["/version", "/api/:path*", "/supply-chain/:path*", "/health", "/ready"]) {
    const index = routes.findIndex(route => route.source === pathname);
    assert(index >= 0 && index < spa);
    assert.equal(routes[index].destination, stagingApiOrigin + pathname);
  }
  assert.equal(prepared.config.git.deploymentEnabled, false);
  assert.match(prepared.config.buildCommand, /^VITE_API_URL= VITE_BASE_PATH=/);
  assert(prepared.html.includes(`rel="canonical" href="${stagingWebOrigin}/"`));
  assert(!JSON.stringify(prepared).includes(currentApiOrigin));
  assert.deepEqual(config, original);
});

test("staging refuses production, missing, and lookalike origins", () => {
  for (const bad of [undefined, currentApiOrigin, stagingApiOrigin + "/", stagingApiOrigin + ".example"]) {
    assert.throws(() => prepareStagingDeployment(config, html, bad, stagingWebOrigin), /staging API/);
  }
  for (const bad of [undefined, currentWebOrigin, stagingWebOrigin + ":444", stagingApiOrigin]) {
    assert.throws(() => prepareStagingDeployment(config, html, stagingApiOrigin, bad), /staging frontend/);
  }
});

test("staging rejects an alternate route to production or an unqualified service", () => {
  for (const destination of [
    currentApiOrigin + "/api/private",
    "//logistics-api.onesa.eu/api/private",
    "https://unqualified.example/",
    "/\\logistics-api.onesa.eu/private",
  ]) {
    const unsafe = structuredClone(config);
    unsafe.rewrites.unshift({ source: "/alternate", destination });
    assert.throws(() => prepareStagingDeployment(unsafe, html, stagingApiOrigin, stagingWebOrigin), /must remain/);
  }
  for (const field of ["routes", "redirects"]) {
    const unsafe = { ...config, [field]: [] };
    assert.throws(() => prepareStagingDeployment(unsafe, html, stagingApiOrigin, stagingWebOrigin), /additional routes/);
  }
});

test("staging CLI emits a preview artifact and leaves both source files untouched", async () => {
  const script = fileURLToPath(new URL("./prepare-deployment.mjs", import.meta.url));
  const configFile = fileURLToPath(new URL("../vercel.json", import.meta.url));
  const htmlFile = fileURLToPath(new URL("../client/index.html", import.meta.url));
  const run = (apiOrigin) => spawnSync(
    process.execPath, [script, "--staging", configFile, htmlFile],
    { encoding: "utf8", env: {
      ...process.env,
      LOGISTICS_STAGE_API_ORIGIN: apiOrigin,
      LOGISTICS_STAGE_WEB_ORIGIN: stagingWebOrigin,
      SMART_LOGISTICS_API_ORIGIN: currentApiOrigin,
      SMART_LOGISTICS_WEB_ORIGIN: currentWebOrigin,
    } },
  );
  const originalConfig = await readFile(configFile, "utf8");
  const good = run(stagingApiOrigin);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).config.git.deploymentEnabled, false);
  const bad = run(currentApiOrigin);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /staging API/);
  assert.equal(await readFile(configFile, "utf8"), originalConfig);
  assert.equal(await readFile(htmlFile, "utf8"), html);
});
