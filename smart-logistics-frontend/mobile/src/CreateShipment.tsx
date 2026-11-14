import { useEffect, useRef, useState } from "react";
import { Button, Text, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { request } from "./api";
export function CreateShipment({
  session,
  onCreated,
}: {
  session: string;
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
    request(session, "/api/operations/shipment-providers")
      .then((data: { providers: string[] }) => {
        if (current) setProviders(data.providers);
      })
      .catch((e: Error) => {
        if (current) setMessage(e.message);
      });
    return () => {
      current = false;
    };
  }, [open, session]);
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
      key.current = { form: fingerprint, value: randomUUID() };
    sending.current = true;
    setBusy(true);
    try {
      const result = await request(
        session,
        "/api/operations/shipments",
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
    <View style={{ gap: 8 }}>
      <Button
        title={open ? "Close shipment creation" : "Create shipment"}
        onPress={() => setOpen(!open)}
      />
      {open && (
        <>
          <TextInput
            accessibilityLabel="Tracking reference"
            placeholder="Tracking reference"
            value={reference}
            onChangeText={setReference}
            maxLength={100}
          />
          <TextInput
            accessibilityLabel="Origin"
            placeholder="Origin"
            value={origin}
            onChangeText={setOrigin}
            maxLength={255}
          />
          <TextInput
            accessibilityLabel="Destination"
            placeholder="Destination"
            value={destination}
            onChangeText={setDestination}
            maxLength={255}
          />
          <Text>Tracking source · {provider || "Workspace operator"}</Text>
          <Button
            title="Use workspace operator"
            onPress={() => setProvider("")}
          />
          {providers.map(p => (
            <Button key={p} title={p} onPress={() => setProvider(p)} />
          ))}
          <Button
            title="Save shipment"
            disabled={busy}
            onPress={() => void submit()}
          />
          {!!message && <Text accessibilityLiveRegion="polite">{message}</Text>}
        </>
      )}
    </View>
  );
}
