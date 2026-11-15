import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  forecastConfiguration,
  sapConfiguration,
  assertIntegrationConfiguration,
  serverSecret,
} from "./config/integrations";
import { readSapMetadata } from "./services/sap";
import { projectEvents } from "./controllers/logisticsIntegrationController";
const keys = [
  "FORECAST_ENABLED",
  "FORECAST_PROVIDER_URL",
  "FORECAST_PROVIDER_NAME",
  "FORECAST_PROVIDER_TOKEN",
  "FORECAST_PROVIDER_TOKEN_FILE",
  "FORECAST_MAX_HORIZON_DAYS",
  "SAP_ENABLED",
  "SAP_SERVICE_URL",
  "SAP_BEARER_TOKEN",
  "SAP_BEARER_TOKEN_FILE",
  "SAP_WORKSPACE_ALLOWLIST",
];
async function environment(
  values: Record<string, string>,
  body: () => unknown,
) {
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, values);
  try {
    await body();
  } finally {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}
const workspace = "11111111-1111-4111-8111-111111111111";
test("SAP adapter makes only the configured metadata read against an isolated HTTP provider", async () => {
  let requests = 0;
  const provider = http.createServer((request, response) => {
    requests++;
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/approved/$metadata");
    assert.equal(
      request.headers.authorization,
      "Bearer isolated-provider-token",
    );
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(
      '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices/></edmx:Edmx>',
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = provider.address();
    assert(address && typeof address === "object");
    await environment(
      {
        SAP_ENABLED: "true",
        SAP_SERVICE_URL: `http://127.0.0.1:${address.port}/approved/`,
        SAP_BEARER_TOKEN: "isolated-provider-token",
        SAP_WORKSPACE_ALLOWLIST: JSON.stringify([workspace]),
      },
      async () => {
        const receipt = await readSapMetadata(workspace);
        assert.equal(receipt.status, "observed");
        assert.equal(requests, 1);
      },
    );
  } finally {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
test("optional adapters default disabled even when an endpoint happens to exist", () =>
  environment(
    {
      FORECAST_PROVIDER_URL: "https://example.invalid/forecast",
      SAP_SERVICE_URL: "https://example.invalid/odata/",
    },
    async () => {
      assert.equal(forecastConfiguration(), null);
      assert.equal(sapConfiguration(), null);
      assert.deepEqual(
        await readSapMetadata(workspace, async () => {
          throw new Error("must not connect");
        }),
        { status: "not-configured" },
      );
    },
  ));
test("explicit activation fails closed on missing, ambiguous or unsafe configuration", () =>
  environment({ FORECAST_ENABLED: "true" }, () => {
    assert.throws(assertIntegrationConfiguration);
    process.env.FORECAST_ENABLED = "yes";
    assert.throws(assertIntegrationConfiguration);
    process.env.FORECAST_ENABLED = "false";
    process.env.SAP_ENABLED = "true";
    assert.throws(assertIntegrationConfiguration);
    process.env.SAP_SERVICE_URL = "https://example.invalid/odata/";
    process.env.SAP_BEARER_TOKEN = "synthetic-token";
    assert.throws(assertIntegrationConfiguration);
    process.env.SAP_WORKSPACE_ALLOWLIST = JSON.stringify([workspace]);
    assert.doesNotThrow(assertIntegrationConfiguration);
    process.env.SAP_SERVICE_URL = "https://user:password@example.invalid/";
    assert.throws(assertIntegrationConfiguration);
  }));
test("server credential references are resolved only from operator files and never included in public metadata receipts", () =>
  environment(
    {
      SAP_ENABLED: "true",
      SAP_SERVICE_URL: "https://example.invalid/odata/",
      SAP_WORKSPACE_ALLOWLIST: JSON.stringify([workspace]),
    },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imsop-adapter-"));
      const file = path.join(dir, "credential");
      fs.writeFileSync(file, "isolated-secret\n", { mode: 0o600 });
      process.env.SAP_BEARER_TOKEN_FILE = file;
      try {
        assert.equal(serverSecret("SAP_BEARER_TOKEN"), "isolated-secret");
        let calls = 0;
        const result = await readSapMetadata(workspace, async (url, init) => {
          calls++;
          assert.equal(String(url), "https://example.invalid/odata/$metadata");
          assert.equal(init?.method, "GET");
          assert.equal(init?.redirect, "error");
          assert.equal(
            (init?.headers as Record<string, string>).Authorization,
            "Bearer isolated-secret",
          );
          return new Response(
            '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices/></edmx:Edmx>',
            { headers: { "content-type": "application/xml" } },
          );
        });
        assert.equal(result.status, "observed");
        assert.equal(calls, 1);
        assert(!JSON.stringify(result).includes("isolated-secret"));
        assert.deepEqual(
          await readSapMetadata(
            "22222222-2222-4222-8222-222222222222",
            async () => {
              throw new Error("unauthorized connection");
            },
          ),
          { status: "not-authorized" },
        );
        process.env.SAP_BEARER_TOKEN = "ambiguous";
        assert.throws(sapConfiguration);
        delete process.env.SAP_BEARER_TOKEN;
        fs.unlinkSync(file);
        assert.throws(sapConfiguration);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  ));
test("SAP rejects HTML fallbacks, XML entities, oversized bodies and provider failures", () =>
  environment(
    {
      SAP_ENABLED: "true",
      SAP_SERVICE_URL: "https://example.invalid/odata/",
      SAP_WORKSPACE_ALLOWLIST: JSON.stringify([workspace]),
      SAP_BEARER_TOKEN: "isolated-token",
    },
    async () => {
      for (const response of [
        new Response("<html>login</html>", {
          headers: { "content-type": "text/html" },
        }),
        new Response("<!DOCTYPE Edmx><Edmx><DataServices/></Edmx>", {
          headers: { "content-type": "application/xml" },
        }),
        new Response("x".repeat(1024 * 1024 + 1), {
          headers: { "content-type": "application/xml" },
        }),
        new Response("unavailable", { status: 503 }),
      ])
        await assert.rejects(readSapMetadata(workspace, async () => response));
    },
  ));
test("forecasting supports server-only file credentials and validates configured limits", () =>
  environment(
    {
      FORECAST_ENABLED: "true",
      FORECAST_PROVIDER_URL: "https://example.invalid/forecast",
      FORECAST_PROVIDER_NAME: "approved-provider",
    },
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imsop-forecast-")),
        file = path.join(dir, "token");
      fs.writeFileSync(file, "synthetic-token", { mode: 0o600 });
      process.env.FORECAST_PROVIDER_TOKEN_FILE = file;
      try {
        assert.equal(forecastConfiguration()?.token, "synthetic-token");
        process.env.FORECAST_MAX_HORIZON_DAYS = "91";
        assert.throws(forecastConfiguration);
        process.env.FORECAST_MAX_HORIZON_DAYS = "30";
        process.env.FORECAST_PROVIDER_URL =
          "https://example.invalid/forecast?token=unsafe";
        assert.throws(forecastConfiguration);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  ));


test("tracking projection freezes delivered and cancelled shipments until an explicit correction", () => {
  const row = (id: string, event: Record<string, unknown>, at: string) => ({
    id,
    payload: JSON.stringify(event),
    occurred_at: new Date(at),
    received_at: new Date(at),
  });
  const event = (eventType: string, status: string, fields: Record<string, unknown> = {}) => ({
    eventType,
    status,
    ...fields,
  });

  const delivered = projectEvents([
    row("created", event("shipment.created", "in_transit", {
      destination: "Initial Depot",
      estimatedArrival: "2026-11-17T12:00:00Z",
      location: { latitude: 1, longitude: 2 },
    }), "2026-11-15T08:00:00Z"),
    row("delivered", event("shipment.delivered", "delivered", {
      destination: "Delivered Dock",
      actualArrival: "2026-11-15T09:00:00Z",
      location: { latitude: 3, longitude: 4 },
    }), "2026-11-15T09:00:00Z"),
    row("late-update", event("shipment.location", "in_transit", {
      destination: "Incorrect Depot",
      estimatedArrival: "2026-11-19T12:00:00Z",
      actualArrival: null,
      location: { latitude: 5, longitude: 6 },
    }), "2026-11-15T10:00:00Z"),
  ]);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.destination, "Delivered Dock");
  assert.equal(delivered.actualArrival, "2026-11-15T09:00:00Z");
  assert.equal(delivered.estimatedArrival, "2026-11-17T12:00:00Z");
  assert.equal(delivered.latitude, 3);
  assert.equal(delivered.longitude, 4);
  assert.equal(delivered.eventId, "delivered");

  const cancelled = projectEvents([
    row("created", event("shipment.created", "in_transit", {
      destination: "Dispatch Yard",
      location: { latitude: 7, longitude: 8 },
    }), "2026-11-15T08:00:00Z"),
    row("cancelled", event("shipment.updated", "cancelled", {
      destination: "Cancellation Hold",
      location: { latitude: 9, longitude: 10 },
    }), "2026-11-15T09:00:00Z"),
    row("late-gps", event("shipment.location", "in_transit", {
      destination: "Unverified Destination",
      location: { latitude: 11, longitude: 12 },
    }), "2026-11-15T10:00:00Z"),
  ]);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.destination, "Cancellation Hold");
  assert.equal(cancelled.latitude, 9);
  assert.equal(cancelled.longitude, 10);
  assert.equal(cancelled.eventId, "cancelled");

  const corrected = projectEvents([
    row("delivered", event("shipment.delivered", "delivered", {
      destination: "Old Destination",
      actualArrival: "2026-11-15T09:00:00Z",
      location: { latitude: 13, longitude: 14 },
    }), "2026-11-15T09:00:00Z"),
    row("correction", event("shipment.corrected", "in_transit", {
      destination: "Corrected Destination",
      actualArrival: null,
      location: null,
    }), "2026-11-15T10:00:00Z"),
    row("after-correction", event("shipment.location", "in_transit", {
      location: { latitude: 15, longitude: 16 },
    }), "2026-11-15T11:00:00Z"),
  ]);
  assert.equal(corrected.status, "in_transit");
  assert.equal(corrected.destination, "Corrected Destination");
  assert.equal(corrected.actualArrival, null);
  assert.equal(corrected.latitude, 15);
  assert.equal(corrected.longitude, 16);
  assert.equal(corrected.eventId, "after-correction");
});
