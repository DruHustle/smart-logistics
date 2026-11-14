import { useEffect, useRef, useState } from "react";
import { requestJSON } from "@/lib/requests";
export function CreateShipment({
  onCreated,
}: {
  onCreated: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [providers, setProviders] = useState<string[]>([]),
    [provider, setProvider] = useState(""),
    [reference, setReference] = useState(""),
    [origin, setOrigin] = useState(""),
    [destination, setDestination] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef<{ form: string; value: string } | null>(null),
    sending = useRef(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    requestJSON("/api/operations/shipment-providers")
      .then((data: { providers: string[] }) => {
        if (current) setProviders(data.providers);
      })
      .catch((e: Error) => {
        if (current) setMessage(e.message);
      });
    return () => {
      current = false;
    };
  }, [open]);
  async function submit() {
    if (sending.current) return;
    const body = {
      trackingNumber: reference.trim(),
      origin: origin.trim(),
      destination: destination.trim(),
      ...(provider && { provider }),
    };
    if (!body.trackingNumber || !body.origin || !body.destination) {
      setMessage("Enter the tracking reference, origin and destination.");
      return;
    }
    const fingerprint = JSON.stringify(body);
    if (key.current?.form !== fingerprint)
      key.current = { form: fingerprint, value: crypto.randomUUID() };
    sending.current = true;
    setBusy(true);
    try {
      const result = await requestJSON(
        "/api/operations/shipments",
        "POST",
        body,
        key.current.value
      );
      onCreated(String(result.id));
      setOpen(false);
      setReference("");
      setOrigin("");
      setDestination("");
      key.current = null;
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Shipment creation could not be confirmed."
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <section>
      <button onClick={() => setOpen(!open)}>
        {open ? "Close shipment creation" : "Create shipment"}
      </button>
      {open && (
        <form
          onSubmit={e => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            Tracking reference
            <input
              value={reference}
              maxLength={100}
              onChange={e => setReference(e.target.value)}
              required
            />
          </label>
          <label>
            Origin
            <input
              value={origin}
              maxLength={255}
              onChange={e => setOrigin(e.target.value)}
              required
            />
          </label>
          <label>
            Destination
            <input
              value={destination}
              maxLength={255}
              onChange={e => setDestination(e.target.value)}
              required
            />
          </label>
          <label>
            Tracking source
            <select
              aria-label="Tracking source"
              value={provider}
              onChange={e => setProvider(e.target.value)}
            >
              <option value="">Workspace operator</option>
              {providers.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy}>Save shipment</button>
          {message && <p role="status">{message}</p>}
        </form>
      )}
    </section>
  );
}
