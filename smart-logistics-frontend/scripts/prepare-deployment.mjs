import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const currentApiOrigin = "https://logistics-api.onesa.eu";
export const currentWebOrigin = "https://logistics.onesa.eu";
export const stagingApiOrigin = "https://logistics-api-staging.onesa.eu";
export const stagingWebOrigin = "https://logistics-staging.onesa.eu";
const apiPaths = ["/version", "/supply-chain/:path*", "/health", "/ready", "/api/:path*"];

export function httpsOrigin(value, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid HTTPS origin`); }
  assert(parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password,
    `${name} must be an HTTPS origin without credentials, a path, query or fragment`);
  assert(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(parsed.hostname), `${name} has an invalid hostname`);
  return parsed.origin;
}

export function prepareDeployment(config, html, apiOrigin, webOrigin) {
  const api = httpsOrigin(apiOrigin, "SMART_LOGISTICS_API_ORIGIN");
  const web = httpsOrigin(webOrigin, "SMART_LOGISTICS_WEB_ORIGIN");
  const result = structuredClone(config);
  const spaIndex = result.rewrites?.findIndex(route => route.destination === "/index.html");
  assert(spaIndex >= 0, "The existing SPA fallback is missing");
  for (const pathname of apiPaths) {
    const matches = result.rewrites.map((route, index) => ({ route, index })).filter(({ route }) => route.source === pathname);
    assert(matches.length === 1 && matches[0].index < spaIndex, `${pathname} must have one proxy route before the SPA fallback`);
    matches[0].route.destination = api + pathname;
  }
  // Root-hosted browser clients use first-party requests; the rewrite owns routing.
  result.buildCommand = "VITE_BASE_PATH=/ pnpm build";
  const nextHtml = html.replaceAll(currentWebOrigin, web);
  assert(nextHtml.includes(`rel="canonical" href="${web}/"`), "The canonical frontend URL could not be prepared");
  return { config: result, html: nextHtml, apiOrigin: api, webOrigin: web };
}

export function prepareStagingDeployment(config, html, apiOrigin, webOrigin) {
  assert(apiOrigin === stagingApiOrigin, "Set LOGISTICS_STAGE_API_ORIGIN to the dedicated staging API");
  assert(webOrigin === stagingWebOrigin, "Set LOGISTICS_STAGE_WEB_ORIGIN to the dedicated staging frontend");
  assert(config.routes === undefined && config.redirects === undefined,
    "Staging does not accept additional routes or redirects");
  const prepared = prepareDeployment(config, html, apiOrigin, webOrigin);
  for (const route of prepared.config.rewrites) {
    if (apiPaths.includes(route.source)) continue;
    assert(typeof route.destination === "string" && route.destination.startsWith("/") &&
      !route.destination.startsWith("//") && !/[\\\r\n]/.test(route.destination) &&
      new URL(route.destination, webOrigin).origin === webOrigin,
    "Additional staging rewrites must remain on the staging frontend");
  }
  prepared.config.git = { ...prepared.config.git, deploymentEnabled: false };
  // A Vite production build otherwise loads the committed production API.
  // Force the browser to use the staging preview's same-origin rewrites.
  prepared.config.buildCommand = "VITE_API_URL= VITE_BASE_PATH=/ pnpm build";
  return prepared;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--staging") {
    const [, , , configPath, htmlPath] = process.argv;
    assert(process.argv.length === 5, "Staging requires the source config and HTML paths");
    const prepared = prepareStagingDeployment(
      JSON.parse(await readFile(configPath, "utf8")),
      await readFile(htmlPath, "utf8"),
      process.env.LOGISTICS_STAGE_API_ORIGIN,
      process.env.LOGISTICS_STAGE_WEB_ORIGIN,
    );
    // Prepare an artifact for a protected preview without editing the source.
    process.stdout.write(JSON.stringify(prepared, null, 2) + "\n");
  } else {
    const configPath = process.argv[2] || "vercel.json";
    const htmlPath = process.argv[3] || "client/index.html";
    const prepared = prepareDeployment(
      JSON.parse(await readFile(configPath, "utf8")),
      await readFile(htmlPath, "utf8"),
      process.env.SMART_LOGISTICS_API_ORIGIN || currentApiOrigin,
      process.env.SMART_LOGISTICS_WEB_ORIGIN || currentWebOrigin,
    );
    await writeFile(configPath, JSON.stringify(prepared.config, null, 2) + "\n");
    await writeFile(htmlPath, prepared.html);
    console.log(`Prepared Smart Logistics frontend ${prepared.webOrigin} with API ${prepared.apiOrigin}`);
  }
}
