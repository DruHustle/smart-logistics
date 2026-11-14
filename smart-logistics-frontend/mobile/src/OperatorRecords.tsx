import React, { useState, useEffect } from "react";
import { ActivityIndicator, Button, Text, View } from "react-native";
import { CreateShipment } from "./CreateShipment";
import { ShipmentStock } from "./ShipmentStock";
import { request } from "./api";

type Card = { key: string; title: string; note: string };
export function OperatorRecords({
  session,
  onError,
}: {
  session: string;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<Card[]>([]),
    [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null),
    [history, setHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false),
    [more, setMore] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setHistory([]);
    if (!selected) {
      setRows([]);
      setMore(false);
    }
    const load = async () => {
      if (selected) {
        const result = await readDetail(session, selected);
        if (current) setHistory(result);
      } else {
        const data = await readPage(session, page);
        if (current) {
          setRows(data.rows);
          setMore(data.more);
        }
      }
    };
    load()
      .catch(e => {
        if (current) onError(e);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open, session, page, selected, refresh]);
  return (
    <View style={{ gap: 10 }}>
      <Button
        title={open ? "Close Shipments" : "Shipments"}
        onPress={() => {
          setOpen(!open);
          setSelected(null);
        }}
      />
      {open && (
        <>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 20, fontWeight: "600" }}
          >
            {selected ? rows.find(x => x.key === selected)?.title : "Shipments"}
          </Text>
          {loading ? (
            <ActivityIndicator />
          ) : selected ? (
            <>
              <Button title="Back to list" onPress={() => setSelected(null)} />
              <ShipmentStock shipment={selected} session={session} />
              {history.map((v, i) => (
                <Text key={i}>{v}</Text>
              ))}
            </>
          ) : (
            <>
              <CreateShipment
                session={session}
                onCreated={id => {
                  setSelected(id);
                  setRefresh(n => n + 1);
                }}
              />
              {rows.map(r => (
                <View key={r.key}>
                  <Button title={r.title} onPress={() => setSelected(r.key)} />
                  <Text>{r.note}</Text>
                </View>
              ))}
              {!rows.length && <Text>No records in this workspace.</Text>}
              {page > 0 && (
                <Button
                  title="Previous page"
                  onPress={() => setPage(page - 1)}
                />
              )}
              {more && (
                <Button title="Next page" onPress={() => setPage(page + 1)} />
              )}
            </>
          )}
          <Button
            title="Refresh records"
            disabled={loading}
            onPress={() => setRefresh(x => x + 1)}
          />
        </>
      )}
    </View>
  );
}

type Shipment = {
  id: number;
  trackingNumber: string;
  origin: string;
  destination: string;
  status: string;
};
async function readPage(session: string, page: number) {
  const data = await request(
    session,
    "/api/operations/shipments?limit=25&offset=" + page * 25
  );
  return {
    rows: data.items.map((s: Shipment) => ({
      key: String(s.id),
      title: s.trackingNumber,
      note: [s.origin + " → " + s.destination, s.status].join(" · "),
    })),
    more: (page + 1) * 25 < data.total,
  };
}
async function readDetail(session: string, key: string) {
  const [s, history] = await Promise.all([
    request(session, "/api/operations/shipments/" + key),
    request(session, "/api/operations/shipments/" + key + "/events?limit=100"),
  ]);
  const events = history.items.map(
    (e: {
      eventType: string;
      occurredAt: string;
      provider: string;
      source?: string;
      position?: { lat: number; lng: number };
    }) =>
      [
        e.occurredAt,
        [e.provider, e.source].filter(Boolean).join(" / "),
        e.eventType,
        e.position && e.position.lat + ", " + e.position.lng,
      ]
        .filter(Boolean)
        .join(" · ")
  );
  return [
    s.origin + " → " + s.destination,
    "Shipment status: " + s.status,
    ...(events.length ? events : ["No tracking events recorded."]),
  ];
}
