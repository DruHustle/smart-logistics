import { type FormEvent, useEffect, useRef, useState } from "react";
import { Panel } from "@/components/Workspace";
import { Button } from "@/components/ui/button";
import { requestJSON } from "@/lib/requests";

type Quote = {
  id: string;
  provider: string;
  reference: string;
  amount: string;
  currency: string;
  validThrough: string | null;
  expired: boolean;
};
type QuotePage = {
  items: Quote[];
  editable: boolean;
  selectedQuoteId: string | null;
  version: number;
  previousOffset: number | null;
  nextOffset: number | null;
};
const emptyQuote = { provider: "", reference: "", amount: "", currency: "", validThrough: "" };

export function ShipmentQuotes({ shipment }: { shipment: string }) {
  const endpoint = `/api/operations/shipments/${encodeURIComponent(shipment)}/quotes`;
  const [page, setPage] = useState<QuotePage>();
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState(emptyQuote);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<{ content: string; key: string } | undefined>(undefined);

  useEffect(() => {
    const control = new AbortController();
    setLoading(true);
    requestJSON(`${endpoint}?offset=${offset}`, "GET", undefined, undefined, control.signal)
      .then((result: QuotePage) => {
        if (control.signal.aborted) return;
        setPage(result);
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

  async function save(action: "record" | "select", fields: Record<string, unknown>) {
    if (saving || loading || !page?.editable) return;
    const body = { action, ...fields };
    const content = JSON.stringify(body);
    if (pending.current?.content !== content) {
      pending.current = { content, key: crypto.randomUUID() };
    }
    setSaving(true);
    setNotice("");
    setProblem("");
    try {
      await requestJSON(endpoint, "POST", body, pending.current.key);
      pending.current = undefined;
      if (action === "record") {
        setForm(emptyQuote);
        setOffset(0);
      }
      setNotice(action === "record" ? "Quote recorded." : "Preferred quote saved.");
      setRefresh(value => value + 1);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The quote change could not be confirmed.");
    } finally {
      setSaving(false);
    }
  }

  function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save("record", { ...form, validThrough: form.validThrough || null });
  }

  return (
    <Panel title="Shipping quotes" description="Record a provider’s price and choose a preferred quote for internal review.">
      {loading && <p role="status">Loading shipping quotes…</p>}
      {page?.items.length === 0 && <p>No quotes recorded.</p>}
      <ul className="space-y-3">
        {page?.items.map(quote => (
          <li key={quote.id} className="event-row">
            <h3>{quote.provider} · {quote.reference}</h3>
            <p>{quote.amount} {quote.currency}</p>
            {quote.validThrough && <p>Valid through {quote.validThrough} UTC</p>}
            {quote.expired && <p>Expired</p>}
            {page.selectedQuoteId === quote.id ? (
              <p>Preferred quote</p>
            ) : page.editable && !quote.expired && (
              <Button type="button" variant="outline" disabled={saving || loading}
                aria-label={`Select quote ${quote.reference}`}
                onClick={() => void save("select", { quoteId: quote.id, expectedVersion: page.version })}>
                Select quote
              </Button>
            )}
          </li>
        ))}
      </ul>
      {page && (page.previousOffset !== null || page.nextOffset !== null) && (
        <div className="flex flex-wrap gap-2">
          {page.previousOffset !== null && (
            <Button type="button" variant="outline" disabled={saving || loading}
              onClick={() => setOffset(page.previousOffset ?? 0)}>Newer quotes</Button>
          )}
          {page.nextOffset !== null && (
            <Button type="button" variant="outline" disabled={saving || loading}
              onClick={() => setOffset(page.nextOffset ?? offset)}>Older quotes</Button>
          )}
        </div>
      )}
      {page?.editable && (
        <form onSubmit={record} className="space-y-3">
          <fieldset disabled={saving || loading} className="space-y-3">
            <label className="field">
              Quote provider
              <input required maxLength={100} value={form.provider}
                onChange={event => setForm({ ...form, provider: event.target.value })} />
            </label>
            <label className="field">
              Quote reference
              <input required maxLength={120} value={form.reference}
                onChange={event => setForm({ ...form, reference: event.target.value })} />
            </label>
            <label className="field">
              Quoted amount
              <input required inputMode="decimal" pattern={"(?:0|[1-9][0-9]{0,13})(?:\\.[0-9]{1,4})?"}
                title="Use digits and an optional decimal point with up to four fractional digits."
                value={form.amount} onChange={event => setForm({ ...form, amount: event.target.value })} />
            </label>
            <label className="field">
              Currency code
              <input required maxLength={3} pattern="[A-Z]{3}" value={form.currency}
                onChange={event => setForm({ ...form, currency: event.target.value.toUpperCase() })} />
            </label>
            <label className="field">
              Valid through (UTC)
              <input type="date" value={form.validThrough}
                onChange={event => setForm({ ...form, validThrough: event.target.value })} />
            </label>
            <Button type="submit">Record quote</Button>
          </fieldset>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      {problem && (
        <div role="alert">
          <p>{problem}</p>
          <Button type="button" variant="outline" disabled={saving || loading}
            onClick={() => setRefresh(value => value + 1)}>Reload quotes</Button>
        </div>
      )}
    </Panel>
  );
}
