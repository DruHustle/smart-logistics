import { useState, useEffect, useRef } from "react";
import { requestJSON } from "@/lib/requests";

type Stock = {
  id: string;
  product: string;
  warehouse: string;
  available: number;
};
type Allocation = {
  id: string;
  inventoryId: string;
  quantity: number;
  state: string;
};
type Snapshot = {
  operationalStatus: string;
  stock: Stock[];
  allocations: Allocation[];
  hasMore: boolean;
  events: {
    action: string;
    actor: string;
    observation: string;
    recordedAt: string;
  }[];
};
type Form = {
  action: string;
  inventoryId: string;
  quantity: number;
  observation: string;
};
export function ShipmentStock({ shipment }: { shipment: string }) {
  const [operationalStatus, setOperationalStatus] = useState("Loading");
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(0),
    [data, setData] = useState<Snapshot | null>(null),
    [refresh, setRefresh] = useState(0);
  const [stock, setStock] = useState(""),
    [quantity, setQuantity] = useState(""),
    [action, setAction] = useState("reserve"),
    [note, setNote] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const inflight = useRef(false),
    intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const path = "/supply-chain/api/v1/shipment-stock/" + shipment;
  useEffect(() => {
    let current = true;
    setOperationalStatus("Loading");
    requestJSON(path + "/status")
      .then((result: { operationalStatus: string }) => {
        if (current) setOperationalStatus(result.operationalStatus);
      })
      .catch(() => {
        if (current) setOperationalStatus("Unavailable");
      });
    return () => {
      current = false;
    };
  }, [path, refresh]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setData(null);
    requestJSON(path + "?offset=" + page * 50)
      .then((result: Snapshot) => {
        if (current) {
          setData(result);
          setOperationalStatus(result.operationalStatus);
        }
      })
      .catch((error: Error) => {
        if (current) setMessage(error.message);
      });
    return () => {
      current = false;
    };
  }, [open, page, refresh, shipment, path]);
  function choose(id: string, next: string, count = "") {
    setStock(id);
    setAction(next);
    setQuantity(count);
    setMessage("");
  }
  async function submit() {
    if (inflight.current) return;
    if (
      !stock ||
      !note.trim() ||
      !/^([1-9]\d*)$/.test(quantity) ||
      !Number.isSafeInteger(Number(quantity))
    ) {
      setMessage(
        "Choose stock and enter a whole quantity and an observed handover or delivery reference."
      );
      return;
    }
    const body: Form = {
      action,
      inventoryId: stock,
      quantity: Number(quantity),
      observation: note.trim(),
    };
    const fingerprint = JSON.stringify([shipment, body]);
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, key: crypto.randomUUID() };
    inflight.current = true;
    setBusy(true);
    try {
      const result = await requestJSON(path, "POST", body, intent.current.key);
      setMessage(
        "Saved " + result.action + " for allocation " + result.allocationId
      );
      setStock("");
      setNote("");
      setQuantity("");
      intent.current = null;
      setRefresh(n => n + 1);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Movement could not be confirmed."
      );
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-label="Shipment stock movements">
      <p aria-live="polite">Operational fulfillment: {operationalStatus}</p>
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? "Close shipment stock" : "Shipment stock and handover"}
      </button>
      {open && (
        <>
          <h3>Shipment stock movements</h3>
          {data?.stock.map(s => (
            <div key={s.id}>
              <button onClick={() => choose(s.id, "reserve")}>
                {s.product} · {s.warehouse} · {s.available} available
              </button>
            </div>
          ))}
          {page > 0 && (
            <button onClick={() => setPage(page - 1)}>
              Previous warehouse stock
            </button>
          )}
          {data?.hasMore && (
            <button onClick={() => setPage(page + 1)}>
              More warehouse stock
            </button>
          )}
          {data?.allocations.map(a => (
            <div key={a.id}>
              <p>
                {a.id} · {a.quantity} units · {a.state}
              </p>
              {(a.state === "reserved"
                ? ["dispatch", "release"]
                : a.state === "dispatched"
                  ? ["deliver"]
                  : []
              ).map(next => (
                <button
                  key={next}
                  onClick={() =>
                    choose(a.inventoryId, next, String(a.quantity))
                  }
                >
                  {next} {a.quantity} units
                </button>
              ))}
            </div>
          ))}
          {data?.events.map((e, i) => (
            <p key={i}>
              {e.recordedAt} · {e.action} · {e.actor} · {e.observation}
            </p>
          ))}
          {!!stock && (
            <div>
              <p>
                {action} · {stock}
              </p>
              <label>
                Movement quantity
                <input
                  type="number"
                  min="1"
                  step="1"
                  readOnly={action !== "reserve"}
                  value={quantity}
                  onChange={e => setQuantity(e.target.value)}
                />
              </label>
              <label>
                Observed handover or delivery proof reference
                <input
                  value={note}
                  maxLength={600}
                  onChange={e => setNote(e.target.value)}
                />
              </label>
              <button disabled={busy} onClick={() => void submit()}>
                Confirm {action}
              </button>
            </div>
          )}
          {message && <p role="status">{message}</p>}
          <button disabled={busy} onClick={() => setRefresh(n => n + 1)}>
            Reload shipment stock
          </button>
        </>
      )}
    </section>
  );
}
