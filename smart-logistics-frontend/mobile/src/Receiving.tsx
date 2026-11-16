import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Button, Text, TextInput, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { request } from "./api";
import {
  purchaseOrders,
  prepareReceipt,
  postReceipt,
  type OrderLine,
  type Receipt,
} from "./receipt";

type Choice = { id: string; name: string };
type Order = { id: string; orderNumber: string; status: string };
export function Receiving({
  session,
  onError,
}: {
  session: string;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(0),
    [warehousePage, setWarehousePage] = useState(0);
  const [orders, setOrders] = useState<Order[]>([]),
    [total, setTotal] = useState(0),
    [warehouses, setWarehouses] = useState<Choice[]>([]),
    [warehouseTotal, setWarehouseTotal] = useState(0);
  const [order, setOrder] = useState<Order | null>(null),
    [lines, setLines] = useState<OrderLine[]>([]),
    [line, setLine] = useState<OrderLine | null>(null),
    [warehouse, setWarehouse] = useState<Choice | null>(null);
  const [quantity, setQuantity] = useState(""),
    [note, setNote] = useState(""),
    [notice, setNotice] = useState(""),
    [storageKey, setStorageKey] = useState("");
  const [pending, setPending] = useState<Receipt | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0);
  const sending = useRef(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setStorageKey("");
    const load = async () => {
      const scope = await request(session, "/api/auth/session");
      if (
        !["admin", "engineer"].includes(scope.role) ||
        !scope.workspaceId ||
        !scope.id
      )
        throw Error("Your current workspace role cannot receive stock.");
      const store = "receipt." + scope.workspaceId + "." + scope.id;
      const value = await SecureStore.getItemAsync(store);
      if (!current) return;
      setStorageKey(store);
      setPending(value ? JSON.parse(value) : null);
      if (value) return;
      if (order) {
        const [l, w] = await Promise.all([
          request(session, purchaseOrders + "/" + order.id + "/items"),
          request(
            session,
            purchaseOrders +
              "/warehouses?paged=true&offset=" +
              warehousePage * 100
          ),
        ]);
        if (current) {
          setLines(l);
          setWarehouses(w.items);
          setWarehouseTotal(w.total);
        }
      } else {
        const o = await request(
          session,
          purchaseOrders + "?offset=" + page * 50
        );
        if (current) {
          setOrders(o.items);
          setTotal(o.total);
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
  }, [open, session, order, page, warehousePage, refresh]);
  async function transmit() {
    if (!storageKey || sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const saved =
        pending ??
        (order && line && warehouse
          ? prepareReceipt(
              order.id,
              line,
              warehouse.id,
              quantity,
              note,
              randomUUID(),
              new Date().toISOString()
            )
          : null);
      if (!saved)
        throw Error("Select an order line and a receiving warehouse.");
      if (!pending) {
        await SecureStore.setItemAsync(storageKey, JSON.stringify(saved));
        setPending(saved);
      }
      const id = await postReceipt(saved, (path, body, key) =>
        request(session, path, body, key)
      );
      await SecureStore.deleteItemAsync(storageKey);
      setPending(null);
      setLine(null);
      setOrder(null);
      setWarehouse(null);
      setNote("");
      setQuantity("");
      setNotice("Warehouse receipt " + id + " recorded.");
      setRefresh(n => n + 1);
    } catch (e) {
      onError(e);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 10 }}>
      <Button
        title={open ? "Close receiving" : "Receive warehouse stock"}
        disabled={busy}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 20, fontWeight: "600" }}
          >
            Warehouse receiving
          </Text>
          {!!notice && <Text accessibilityLiveRegion="polite">{notice}</Text>}
          {loading ? (
            <ActivityIndicator />
          ) : pending ? (
            <>
              <Text>
                Saved receipt for order {pending.orderId}.{" "}
                {pending.body.items[0]?.quantity} units observed at{" "}
                {pending.body.receivedAt}.
              </Text>
              <Text>{pending.body.note}</Text>
              <Button
                title="Retry saved receipt"
                disabled={busy}
                onPress={() => void transmit()}
              />
            </>
          ) : (
            !!storageKey &&
            (!order ? (
              <>
                {orders.map(o => (
                  <Button
                    key={o.id}
                    title={o.orderNumber + " · " + o.status}
                    onPress={() => {
                      setOrder(o);
                      setLine(null);
                      setWarehouse(null);
                      setNote("");
                      setQuantity("");
                      setWarehousePage(0);
                    }}
                  />
                ))}
                {orders.length === 0 && (
                  <Text>No purchase orders in this workspace.</Text>
                )}
                {page > 0 && (
                  <Button
                    title="Previous orders"
                    onPress={() => setPage(page - 1)}
                  />
                )}
                {(page + 1) * 50 < total && (
                  <Button
                    title="More orders"
                    onPress={() => setPage(page + 1)}
                  />
                )}
              </>
            ) : (
              <>
                <Button title="Back to orders" onPress={() => setOrder(null)} />
                <Text>{order.orderNumber}</Text>
                {lines
                  .filter(l => l.quantity > l.receivedQuantity)
                  .map(l => (
                    <Button
                      key={l.id}
                      title={
                        (line?.id === l.id ? "Selected · " : "") +
                        l.productId +
                        " · " +
                        (l.quantity - l.receivedQuantity) +
                        " outstanding"
                      }
                      onPress={() => {
                        setLine(l);
                        setQuantity("");
                      }}
                    />
                  ))}
                {!lines.some(l => l.quantity > l.receivedQuantity) && (
                  <Text>No outstanding items.</Text>
                )}
                {line && (
                  <>
                    <Text>Receiving warehouse</Text>
                    {warehouses.map(w => (
                      <Button
                        key={w.id}
                        title={
                          (warehouse?.id === w.id ? "Selected · " : "") + w.name
                        }
                        onPress={() => setWarehouse(w)}
                      />
                    ))}
                    {warehousePage > 0 && (
                      <Button
                        title="Previous warehouses"
                        onPress={() => setWarehousePage(warehousePage - 1)}
                      />
                    )}
                    {(warehousePage + 1) * 100 < warehouseTotal && (
                      <Button
                        title="More warehouses"
                        onPress={() => setWarehousePage(warehousePage + 1)}
                      />
                    )}
                    <TextInput
                      accessibilityLabel="Observed quantity"
                      placeholder="Observed quantity"
                      keyboardType="number-pad"
                      value={quantity}
                      onChangeText={setQuantity}
                    />
                    <TextInput
                      accessibilityLabel="Receiving note"
                      placeholder="Receiving note"
                      value={note}
                      maxLength={300}
                      onChangeText={setNote}
                    />
                    <Button
                      title="Record observed receipt now"
                      disabled={busy || !warehouse || !quantity || !note.trim()}
                      onPress={() => void transmit()}
                    />
                  </>
                )}
              </>
            ))
          )}
        </>
      )}
    </View>
  );
}
