/** Bound interactive OIDC API calls even if a native fetch implementation ignores abort. */
export async function fetchIdentity(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
  transport: typeof fetch = fetch,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Error("Invalid sign-in deadline.");
  const controller = new AbortController();
  const external = init.signal;
  const abort = () => controller.abort();
  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("Onesa sign-in did not respond in time. Please retry."));
    }, timeoutMs);
  });
  try {
    // Do not follow unexpected redirects or cache a previous authorization response.
    return await Promise.race([
      transport(url, { ...init, signal: controller.signal, redirect: "error", cache: "no-store" }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }
}
