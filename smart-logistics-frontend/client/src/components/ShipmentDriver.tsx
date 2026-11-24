import { useEffect, useRef, useState } from "react";
import { Panel } from "@/components/Workspace";
import { Button } from "@/components/ui/button";
import { requestJSON } from "@/lib/requests";
import { formatTime } from "@/lib/workspace";

type Driver = { id: number; name: string };
type Assignment = {
  driverId: number | null;
  driverName: string | null;
  driverUnavailable: boolean;
  recordedAt: string | null;
  version: number;
};
type DriverPage = {
  assignment: Assignment;
  candidates: Driver[];
  editable: boolean;
  previousOffset: number | null;
  nextOffset: number | null;
};

export function ShipmentDriver({ shipment }: { shipment: string }) {
  const endpoint = `/api/operations/shipments/${encodeURIComponent(shipment)}/driver-assignment`;
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<DriverPage>();
  const [selection, setSelection] = useState<{ driver: Driver | null; version: number }>();
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const pending = useRef<{ body: string; id: string } | null>(null);

  useEffect(() => {
    const control = new AbortController();
    setLoading(true);
    requestJSON(`${endpoint}?offset=${offset}`, "GET", undefined, undefined, control.signal)
      .then((data: DriverPage) => {
        if (control.signal.aborted) return;
        setPage(data);
        setProblem("");
      })
      .catch((error: Error) => {
        if (!control.signal.aborted) setProblem(error.message);
      })
      .finally(() => {
        if (!control.signal.aborted) setLoading(false);
      });
    return () => control.abort();
  }, [endpoint, offset, refresh]);

  const assignment = page?.assignment;
  const current = assignment?.driverId != null && assignment.driverName !== null
    ? { id: assignment.driverId, name: assignment.driverName }
    : null;
  const chosen = selection === undefined ? current : selection.driver;
  const candidates = [...(page?.candidates ?? [])];
  if (chosen && !candidates.some(driver => driver.id === chosen.id)) {
    candidates.unshift(chosen);
  }
  const changed = selection !== undefined && (
    (selection.driver?.id ?? null) !== (assignment?.driverId ?? null) ||
    !!assignment?.driverUnavailable
  );

  function reset() {
    pending.current = null;
    setSelection(undefined);
    setRefresh(value => value + 1);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || loading || !page?.editable || !selection || !changed) return;
    const body = { driverId: chosen?.id ?? null, expectedVersion: selection.version };
    const serialized = JSON.stringify(body);
    if (pending.current?.body !== serialized) {
      pending.current = { body: serialized, id: crypto.randomUUID() };
    }
    setProblem("");
    setNotice("");
    setSaving(true);
    try {
      await requestJSON(endpoint, "PUT", body, pending.current.id);
      reset();
      setNotice("Driver assignment saved.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Assignment could not be confirmed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="Dispatch driver" description="Assign an active workspace member to this shipment.">
      {loading && !page && <p role="status">Loading driver assignment…</p>}
      {assignment && (
        <p>
          {current?.name ?? (assignment.driverUnavailable ? "Assigned member is unavailable" : "No driver assigned")}
          {assignment.recordedAt && ` · Updated ${formatTime(assignment.recordedAt)}`}
        </p>
      )}
      {page?.editable && (
        <form onSubmit={save} className="space-y-3">
          <label className="field">
            Driver
            <select
              value={chosen?.id ?? (!selection && assignment?.driverUnavailable ? "" : "unassigned")}
              disabled={saving || loading}
              onChange={event => setSelection({
                driver: candidates.find(driver => String(driver.id) === event.target.value) ?? null,
                version: page.assignment.version,
              })}
            >
              {assignment?.driverUnavailable && <option value="" disabled>Choose a replacement</option>}
              <option value="unassigned">Unassigned</option>
              {candidates.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            {page.previousOffset !== null && (
              <Button type="button" variant="outline" disabled={saving || loading}
                onClick={() => setOffset(page.previousOffset ?? 0)}>
                Previous workspace members
              </Button>
            )}
            {page.nextOffset !== null && (
              <Button type="button" variant="outline" disabled={saving || loading}
                onClick={() => setOffset(page.nextOffset ?? offset)}>
                More workspace members
              </Button>
            )}
            <Button type="submit" disabled={saving || loading || !changed}>Save driver</Button>
          </div>
        </form>
      )}
      {page && !page.editable && <p>Assignment is closed for this shipment.</p>}
      {notice && <p role="status">{notice}</p>}
      {problem && (
        <div role="alert">
          <p>{problem}</p>
          <Button type="button" variant="outline" disabled={saving || loading} onClick={reset}>
            Reload driver assignment
          </Button>
        </div>
      )}
    </Panel>
  );
}
