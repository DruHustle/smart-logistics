import { useState } from "react";
import { Button } from "@/components/ui/button";
import { demoShipments } from "@/lib/demo-data";

const trackingRoute = "#/supply-chain/shipments";
const features = [
  {
    label: "Operational overview",
    route: "#/",
    description: "See open shipments, pending orders and delivery exceptions together.",
    sample: "Three active shipments, including one that needs attention.",
  },
  {
    label: "Shipment tracking",
    route: trackingRoute,
    description: "Follow dispatches, delivery progress and exceptions.",
    sample: "A delayed shipment from Hamburg to New York.",
  },
  {
    label: "Order management",
    route: "#/supply-chain/orders",
    description: "Track fulfilment, manage purchase orders and record inventory receipts.",
    sample: "A purchase order for 12 cartons with 10 cartons received.",
  },
  {
    label: "Logistics analytics",
    route: "#/insights/analytics",
    description: "Compare shipment activity by status and transport mode.",
    sample: "In-transit, delayed and delivered shipments in a shared view.",
  },
  {
    label: "Exception review",
    route: "#/insights/recommendations",
    description: "Assign follow-up on delivery problems and record how they were resolved.",
    sample: "A delayed delivery assigned for review with a rescheduled arrival.",
  },
  {
    label: "Logistics assistant",
    route: "#/insights/assistant",
    description: "Ask questions about your authorized shipment and order records.",
    sample: "Find the latest tracking observation for a specific shipment.",
  },
];

const shipmentStatuses = Array.from(
  new Set(demoShipments.map(shipment => shipment.status))
).sort();

export default function PublicPreview({
  disabled,
  signIn,
}: {
  disabled: boolean;
  signIn: (destination: string) => void;
}) {
  const [status, setStatus] = useState("");
  const shipments = demoShipments.filter(
    shipment => !status || shipment.status === status
  );
  const trackingDestination = status
    ? trackingRoute + "?" + new URLSearchParams({ status })
    : trackingRoute;

  return (
    <section aria-labelledby="logistics-preview" className="glass-panel relative z-10 w-full max-w-4xl space-y-5 rounded-xl border p-5 sm:p-7">
      <div className="space-y-2">
        <h1 id="logistics-preview" className="text-xl font-semibold">
          Explore Smart Logistics
        </h1>
        <p className="text-sm text-muted-foreground">
          See how dispatchers and supply chain teams track shipments, manage orders and review performance.
        </p>
      </div>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Explore with sample data</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            Your selected status carries over to shipment tracking after sign-in.
          </p>
          <label className="flex flex-wrap items-center gap-2 text-sm" htmlFor="preview-status">
            Shipment status
            <select
              id="preview-status"
              className="rounded-md border bg-background p-2"
              value={status}
              onChange={event => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              {shipmentStatuses.map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <p role="status" className="text-sm">{shipments.length} sample shipments</p>
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Sample shipment tracking</caption>
              <thead>
                <tr>
                  <th scope="col" className="p-2">Shipment</th>
                  <th scope="col" className="p-2">Route</th>
                  <th scope="col" className="p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {shipments.map(shipment => (
                  <tr className="border-t" key={shipment.id}>
                    <th scope="row" className="p-2 font-medium">{shipment.trackingNumber}</th>
                    <td className="p-2">{shipment.origin} → {shipment.destination}</td>
                    <td className="p-2">{shipment.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
      <div className="grid gap-3 sm:grid-cols-3">
        {features.map(feature => (
          <article key={feature.route} className="flex flex-col gap-2 rounded-md border p-3">
            <h2 className="font-semibold">{feature.label}</h2>
            <p className="text-sm">{feature.description}</p>
            <p className="flex-1 text-xs text-muted-foreground">Sample data · {feature.sample}</p>
            <Button
              type="button"
              variant="outline"
              className="mt-1 whitespace-normal"
              disabled={disabled}
              onClick={() => signIn(feature.route === trackingRoute ? trackingDestination : feature.route)}
            >
              Sign in for {feature.label.toLowerCase()}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
