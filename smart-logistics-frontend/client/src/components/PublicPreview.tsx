import { useState } from "react";
import { Button } from "@/components/ui/button";
import { demoShipments } from "@/lib/demo-data";

const features = [
  {
    label: "Shipment tracking",
    route: "#/supply-chain/shipments",
    description: "Follow dispatches, delivery progress and exceptions.",
    sample: "A delayed shipment from Hamburg to New York.",
  },
  {
    label: "Order management",
    route: "#/supply-chain/orders",
    description: "Review customer orders and monitor fulfilment.",
    sample: "A pending order awaiting dispatch.",
  },
  {
    label: "Logistics analytics",
    route: "#/insights/analytics",
    description: "Compare shipment activity by status and transport mode.",
    sample: "In-transit, delayed and delivered shipments in a shared view.",
  },
];

const shipmentStatuses = Array.from(new Set(demoShipments.map(shipment => shipment.status))).sort();

export default function PublicPreview({
  disabled,
  signIn,
}: {
  disabled: boolean;
  signIn: (destination: string) => void;
}) {
  const [status, setStatus] = useState("");
  const shipments = demoShipments.filter(shipment => !status || shipment.status === status);

  return (
    <section aria-labelledby="logistics-preview" className="glass-panel relative z-10 w-full max-w-4xl space-y-5 rounded-xl border p-5 sm:p-7">
      <div className="space-y-2">
        <h2 id="logistics-preview" className="text-xl font-semibold">Explore Smart Logistics</h2>
        <p className="text-sm text-muted-foreground">
          See how dispatchers and supply chain teams track shipments, manage orders and review performance.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {features.map(feature => (
          <article key={feature.route} className="flex flex-col gap-2 rounded-md border p-3">
            <h3 className="font-semibold">{feature.label}</h3>
            <p className="text-sm">{feature.description}</p>
            <p className="flex-1 text-xs text-muted-foreground">Sample data · {feature.sample}</p>
            <Button type="button" variant="outline" className="mt-1 whitespace-normal" disabled={disabled}
              onClick={() => signIn(feature.route)}>
              Sign in for {feature.label.toLowerCase()}
            </Button>
          </article>
        ))}
      </div>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Explore with sample data</summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">Sample shipments. Your filters stay in this preview.</p>
          <label className="flex flex-wrap items-center gap-2 text-sm" htmlFor="preview-status">
            Shipment status
            <select id="preview-status" className="rounded-md border bg-background p-2"
              value={status} onChange={event => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {shipmentStatuses.map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          <p role="status" className="text-sm">{shipments.length} sample shipments</p>
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Sample shipment tracking</caption>
              <thead><tr>
                <th scope="col" className="p-2">Shipment</th>
                <th scope="col" className="p-2">Route</th>
                <th scope="col" className="p-2">Status</th>
              </tr></thead>
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
    </section>
  );
}
