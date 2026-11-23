import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Button,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { finish, start, register, registeredDestination, registrationReturn } from "./src/signin";
import { title, queue, redirect } from "./src/config";
import {
  actionLabel,
  complete,
  detail,
  done,
  keyOf,
  list,
  SessionExpired,
  signOut,
  validKey,
  type Detail,
  type Item,
} from "./src/api";

import { Receiving } from "./src/Receiving";
import { OperatorRecords } from "./src/OperatorRecords";

const sampleWorkflows = [
  {
    name: "Shipment tracking",
    description: "See where a shipment is and what changed.",
    example: "Sample shipment SL-204 · In transit · Left the depot at 08:40.",
  },
  {
    name: "Inventory receiving",
    description: "Check delivered quantities against a purchase order.",
    example: "Sample order PO-301 · 12 cartons expected · 10 received.",
  },
  {
    name: "Exception handling",
    description: "Review a delay and record how it was resolved.",
    example: "Sample delay · Replacement vehicle assigned · Delivery rescheduled for 16:00.",
  },
];

function PublicPreview() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <View style={styles.section}>
      <Text style={styles.body}>
        Supply chain teams track shipments, receive inventory and resolve delivery exceptions.
      </Text>
      {sampleWorkflows.map(workflow => {
        const expanded = selected === workflow.name;
        return (
          <View key={workflow.name} style={styles.card}>
            <Text style={styles.name}>{workflow.name}</Text>
            <Text style={styles.body}>{workflow.description}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={expanded ? `Hide sample ${workflow.name.toLowerCase()}` : `Show sample ${workflow.name.toLowerCase()}`}
              accessibilityState={{ expanded }}
              onPress={() => setSelected(expanded ? null : workflow.name)}
              style={styles.sampleAction}
            >
              <Text style={styles.sampleActionText}>{expanded ? "Hide sample" : "Show sample"}</Text>
            </Pressable>
            {expanded && <Text style={styles.body}>{workflow.example}</Text>}
          </View>
        );
      })}
    </View>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [rows, setRows] = useState<Item[]>([]);
  const [record, setRecord] = useState<Detail | null>(null);
  const [outcome, setOutcome] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const submitting = useRef(false);
  const safeError = (e: unknown) => {
    if (!(e instanceof Error)) return setInfo("Please try again.");
    if (e.message === "onesa_denied")
      return setInfo("Onesa sign-in was cancelled. You can try again.");
    if (e.message === "unauthorized")
      return setInfo("This Onesa sign-in attempt expired. Please try again.");
    setInfo(e.message);
  };
  function fail(e: unknown) {
    if (e instanceof SessionExpired) {
      setToken(null);
      setRows([]);
      setRecord(null);
    }
    safeError(e);
  }
  async function enroll(audience: "user" | "admin") {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const url = await register(destination, audience);
      if (url) await receive(url);
    } catch (error) {
      fail(error);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const resumingRegistration = useRef(false);
  async function receive(url: string) {
    try {
      if (url === registrationReturn) {
        if (resumingRegistration.current) return;
        resumingRegistration.current = true;
        try {
          const requested = await registeredDestination();
          if (requested === undefined) return;
          const target = requested && validKey(requested) ? requested : null;
          setDestination(target);
          const callback = await start(target);
          if (callback) await receive(callback);
        } finally { resumingRegistration.current = false; }
      } else if (url.startsWith(redirect + "?")) {
        const result = await finish(url);
        if (result) {
          setDestination(result.destination);
          setToken(result.session);
          setInfo("");
        }
      } else {
        const parsed = new URL(url);
        const key = parsed.pathname.slice(1);
        if (
          parsed.protocol === new URL(redirect).protocol &&
          parsed.host === "record" &&
          validKey(key)
        ) {
          setDestination(key);
          setRecord(null);
          setOutcome("");
          setInfo("");
        }
      }
    } catch (e) {
      safeError(e);
    }
  }
  useEffect(() => {
    const sub = Linking.addEventListener("url", e => {
      void receive(e.url);
    });
    Linking.getInitialURL()
      .then(url => {
        if (url) void receive(url);
      })
      .catch(safeError);
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!token) return;
    let active = true;
    setBusy(true);
    setInfo("");
    setRecord(null);
    setRows([]);
    const load = async () => {
      if (destination) {
        const result = await detail(token, destination);
        if (active) setRecord(result);
      } else {
        const result = await list(token);
        if (active) setRows(result);
      }
    };
    load()
      .catch(e => {
        if (active) fail(e);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [token, destination, refresh]);
  async function login() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setInfo("");
    try {
      const url = await start(destination);
      if (url) await receive(url);
    } catch (e) {
      safeError(e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (!token || !record || !outcome.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await complete(token, record.item, outcome.trim());
      setOutcome("");
      setRefresh(r => r + 1);
    } catch (e) {
      fail(e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function logout() {
    if (!token) return;
    setToken(null);
    setDestination(null);
    setOutcome("");
    setRecord(null);
    setRows([]);
    setInfo("");
    try {
      await signOut(token);
    } catch {
      setInfo("Signed out on this device. The server session will expire.");
    }
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.screen}
        >
          <Text style={styles.brand}>{title}</Text>
          <Text accessibilityRole="header" style={styles.heading}>
            {token ? record?.item.title ?? queue : "Explore Smart Logistics"}
          </Text>
          {!!info && (
            <Text accessibilityLiveRegion="polite" style={styles.notice}>
              {info}
            </Text>
          )}
          {!token ? (
            <View style={styles.section}>
              <Text style={styles.body}>
                Sign in to open{" "}
                {destination
                  ? "the selected record"
                  : "your assigned workspace"}
                .
              </Text>
              <Button
                title="Sign in with Onesa"
                onPress={login}
                disabled={busy}
              />
              <Button title="Create an Onesa account" disabled={busy} onPress={() => void enroll("user")} />
              <Button title="Request administrator access" disabled={busy} onPress={() => void enroll("admin")} />
              <PublicPreview />
            </View>
          ) : (
            <View style={styles.section}>
              {!destination && <Receiving session={token} onError={fail} />}
              {!destination && (
                <OperatorRecords session={token} onError={fail} />
              )}
              {destination && (
                <Button
                  title={"Back to " + queue.toLowerCase()}
                  onPress={() => {
                    setDestination(null);
                    setOutcome("");
                  }}
                />
              )}
              {busy && <ActivityIndicator accessibilityLabel="Loading" />}
              {!destination &&
                rows.map(row => (
                  <Pressable
                    accessibilityRole="button"
                    key={keyOf(row)}
                    style={styles.card}
                    onPress={() => {
                      setRecord(null);
                      setDestination(keyOf(row));
                      setOutcome("");
                    }}
                  >
                    <Text style={styles.name}>{row.title}</Text>
                    <Text style={styles.body}>{row.summary}</Text>
                  </Pressable>
                ))}
              {!destination && !busy && !info && !rows.length && (
                <Text style={styles.body}>No records in this queue.</Text>
              )}
              {record && (
                <View style={styles.section}>
                  <Text style={styles.body}>{record.item.summary}</Text>
                  {!done(record.item) && (
                    <>
                      <Text style={styles.name}>Observed outcome</Text>
                      <TextInput
                        accessibilityLabel="Observed outcome"
                        style={styles.input}
                        value={outcome}
                        onChangeText={setOutcome}
                        multiline
                        maxLength={1000}
                      />
                      <Button
                        title={actionLabel}
                        disabled={busy || !outcome.trim()}
                        onPress={() =>
                          Alert.alert(actionLabel, record.item.title, [
                            { text: "Cancel", style: "cancel" },
                            { text: "Confirm", onPress: () => void save() },
                          ])
                        }
                      />
                    </>
                  )}
                  <Text style={styles.name}>History</Text>
                  {record.history.map((a, i) => (
                    <Text key={i} style={styles.body}>
                      {a}
                    </Text>
                  ))}
                </View>
              )}
              <Button
                title="Refresh"
                disabled={busy}
                onPress={() => setRefresh(n => n + 1)}
              />
              <Button title="Sign out" disabled={busy} onPress={logout} />
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f3f6f7" },
  screen: {
    padding: 22,
    gap: 16,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
  },
  section: { gap: 14 },
  brand: { fontSize: 16, color: "#315b62", fontWeight: "600" },
  heading: { fontSize: 34, color: "#16272e", fontWeight: "700" },
  body: { fontSize: 17, lineHeight: 25, color: "#30464e" },
  name: { fontSize: 19, fontWeight: "600", color: "#183740" },
  notice: { fontSize: 16, color: "#753923" },
  sampleAction: {
    minHeight: 44,
    justifyContent: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 4,
  },
  sampleActionText: { fontSize: 16, fontWeight: "600", color: "#24555d" },
  card: {
    backgroundColor: "#fff",
    padding: 18,
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#bdcdd0",
  },
  input: {
    fontSize: 17,
    minHeight: 88,
    borderColor: "#637f85",
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    backgroundColor: "#fff",
  },
});
