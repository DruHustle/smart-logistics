import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { openAuthSessionAsync } from "expo-web-browser";
import { PendingOnesaTransactions } from "./callback";
import { issuer, origin, redirect } from "./config";

const key = "operator.signin.pending";
const transactions = new PendingOnesaTransactions({
  read: () => SecureStore.getItemAsync(key),
  write: value =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  remove: () => SecureStore.deleteItemAsync(key),
});
const random = () =>
  Array.from(Crypto.getRandomBytes(32), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
const endpoint = origin + "/api/auth/onesa/native";

export async function start(destination: string | null) {
  const response = await fetch(endpoint + "/config");
  if (!response.ok)
    throw Error("Onesa sign-in is unavailable. Try again later.");
  const config = await response.json();
  if (
    config.issuer !== issuer ||
    config.redirect !== redirect ||
    typeof config.audience !== "string" ||
    !/^https:\/\//.test(config.audience) ||
    !/^[a-zA-Z0-9_-]{16,128}$/.test(config.client)
  )
    throw Error("The identity configuration needs attention.");
  const verifier = random(),
    state = random(),
    nonce = random();
  const challenge = (
    await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      verifier,
      { encoding: Crypto.CryptoEncoding.BASE64 }
    )
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const params = new URLSearchParams({
    response_type: "code",
    scope: "openid email profile",
    client_id: config.client,
    audience: config.audience,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirect,
  });
  await transactions.save({
    origin,
    issuer,
    state,
    verifier,
    nonce,
    destination,
    expires: Date.now() + 300000,
  });
  try {
    const result = await openAuthSessionAsync(
      issuer + "authorize?" + params,
      redirect
    );
    if (result.type === "success") return result.url;
    await transactions.clear(state);
    return null;
  } catch (error) {
    await transactions.clear(state);
    throw error;
  }
}

export async function finish(url: string) {
  const result = await transactions.claim(url, origin);
  if (!result) return null;
  const { code, pending } = result;
  const response = await fetch(endpoint + "/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      verifier: pending.verifier,
      nonce: pending.nonce,
    }),
  });
  if (!response.ok)
    throw Error(
      response.status === 403
        ? "Ask your administrator for access to this workspace."
        : "Sign-in could not be completed. Start again."
    );
  const { session } = await response.json();
  if (typeof session !== "string" || !session)
    throw Error("Your sign-in did not return a session.");
  return { session, destination: pending.destination };
}

const registrationKey = "operator.registration.pending";
export const registrationReturn = "eu.onesa.logistics://signin/registered";

export async function register(destination: string | null) {
  if (Platform.OS !== "ios" && Platform.OS !== "android") throw Error("Unsupported registration platform.");
  await SecureStore.setItemAsync(registrationKey, JSON.stringify({destination}), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  const url = "https://auth.onesa.eu/register?audience=user&product=logistics&platform=" + Platform.OS;
  const result = await openAuthSessionAsync(url, registrationReturn);
  if (result.type === "success" && result.url === registrationReturn) return result.url;
  await SecureStore.deleteItemAsync(registrationKey);
  return null;
}

export async function registeredDestination(): Promise<string | null | undefined> {
  const stored = await SecureStore.getItemAsync(registrationKey);
  if (!stored) return undefined;
  await SecureStore.deleteItemAsync(registrationKey);
  const {destination} = JSON.parse(stored);
  return typeof destination === "string" ? destination : null;
}
