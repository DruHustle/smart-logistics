import { useState, useEffect, useRef } from "react";
import { View, Text, Button, TextInput } from "react-native";
import { randomUUID } from "expo-crypto";
import { request } from "./api";

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
export function ShipmentStock({
  shipment,
  session,
}: {
  shipment: string;
  session: string;
}) {
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
    if (!open) return;
    let current = true;
    setData(null);
    request(session, path + "?offset=" + page * 50)
      .then((result: Snapshot) => {
        if (current) setData(result);
      })
      .catch((error: Error) => {
        if (current) setMessage(error.message);
      });
    return () => {
      current = false;
    };
  }, [open, page, refresh, shipment, session]);
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
      intent.current = { fingerprint, key: randomUUID() };
    inflight.current = true;
    setBusy(true);
    try {
      const result = await request(session, path, body, intent.current.key);
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
    <View style={{ gap: 8 }}>
      <Button
        title={open ? "Close shipment stock" : "Shipment stock and handover"}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <Text accessibilityRole="header">Shipment stock movements</Text>
          {data?.stock.map(s => (
            <Button
              key={s.id}
              title={
                s.product +
                " · " +
                s.warehouse +
                " · " +
                s.available +
                " available"
              }
              onPress={() => choose(s.id, "reserve")}
            />
          ))}
          {page > 0 && (
            <Button
              title="Previous warehouse stock"
              onPress={() => setPage(page - 1)}
            />
          )}
          {data?.hasMore && (
            <Button
              title="More warehouse stock"
              onPress={() => setPage(page + 1)}
            />
          )}
          {data?.allocations.map(a => (
            <View key={a.id}>
              <Text>
                {a.id} · {a.quantity} units · {a.state}
              </Text>
              {(a.state === "reserved"
                ? ["dispatch", "release"]
                : a.state === "dispatched"
                  ? ["deliver"]
                  : []
              ).map(next => (
                <Button
                  key={next}
                  title={next + " " + a.quantity + " units"}
                  onPress={() =>
                    choose(a.inventoryId, next, String(a.quantity))
                  }
                />
              ))}
            </View>
          ))}
          {data?.events.map((e, i) => (
            <Text key={i}>
              {e.recordedAt} · {e.action} · {e.actor} · {e.observation}
            </Text>
          ))}
          {!!stock && (
            <>
              <Text>
                {action} · {stock}
              </Text>
              <TextInput
                accessibilityLabel="Movement quantity"
                placeholder="Movement quantity"
                keyboardType="number-pad"
                editable={action === "reserve"}
                value={quantity}
                onChangeText={setQuantity}
              />
              <TextInput
                accessibilityLabel="Observed handover or delivery proof reference"
                placeholder="Observed handover or delivery proof reference"
                maxLength={600}
                value={note}
                onChangeText={setNote}
              />
              <Button
                title={"Confirm " + action}
                disabled={busy}
                onPress={() => void submit()}
              />
            </>
          )}
          {!!message && <Text accessibilityLiveRegion="polite">{message}</Text>}
          <Button
            title="Reload shipment stock"
            disabled={busy}
            onPress={() => setRefresh(n => n + 1)}
          />
        </>
      )}
    </View>
  );
}
