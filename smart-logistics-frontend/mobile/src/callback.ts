export type PendingOnesa = {
  state: string;
  nonce?: string;
  verifier: string;
  issuer: string;
  origin: string;
  destination: string | null;
  expires: number;
};

export function nativeCode(
  incoming: string,
  pending: PendingOnesa,
  origin: string,
  now = Date.now()
): string {
  const url = new URL(incoming);
  const p = url.searchParams;
  if (
    url.protocol !== "eu.onesa.logistics:" ||
    url.host !== "signin" ||
    url.pathname !== "/callback" ||
    url.username ||
    url.password ||
    url.hash ||
    pending.origin !== origin ||
    pending.expires <= now ||
    p.getAll("state").length !== 1 ||
    p.get("state") !== pending.state ||
    (p.has("iss") &&
      (p.getAll("iss").length !== 1 || p.get("iss") !== pending.issuer))
  ) {
    throw new Error("unauthorized");
  }
  if (p.has("error"))
    throw new Error(
      p.get("error") === "access_denied" ? "onesa_denied" : "unauthorized"
    );
  const code = p.get("code");
  if (!code || code.length > 4096 || p.getAll("code").length !== 1)
    throw new Error("unauthorized");
  return code;
}

export function ownsNativeCallback(incoming: string, pending: PendingOnesa): boolean {
  try {
    nativeCode(incoming, pending, pending.origin);
    return true;
  } catch (error) {
    return error instanceof Error && error.message === "onesa_denied";
  }
}

export async function receiveBrowserCallback(
  open: () => Promise<{ type: string; url?: string }>,
  subscribe: (receive: (url: string) => void) => () => void,
  accepts: (url: string) => boolean,
  graceMs: number,
): Promise<string | null> {
  let receive: (url: string) => void = () => {};
  const delivered = new Promise<string>(resolve => { receive = resolve; });
  const unsubscribe = subscribe(url => { if (accepts(url)) receive(url); });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      delivered,
      open(),
    ]);
    if (typeof first === "string") return first;
    if (first.type === "success") {
      if (typeof first.url !== "string" || !accepts(first.url)) throw Error("unauthorized");
      return first.url;
    }
    if (graceMs <= 0) return null;
    const deadline = new Promise<null>(resolve => {
      timeout = setTimeout(() => resolve(null), graceMs);
    });
    return await Promise.race([delivered, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unsubscribe();
  }
}

type PendingStore = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
};

/** SecureStore has no atomic read-and-delete operation for a one-time callback. */
export class PendingOnesaTransactions {
  private idle: Promise<void> = Promise.resolve();

  constructor(private readonly store: PendingStore) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.idle.then(action);
    this.idle = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  save(attempt: PendingOnesa): Promise<void> {
    return this.serialize(() => this.store.write(JSON.stringify(attempt)));
  }

  clear(state: string): Promise<void> {
    return this.serialize(async () => {
      const raw = await this.store.read();
      if (raw && JSON.parse(raw).state === state) await this.store.remove();
    });
  }

  claim(
    incoming: string,
    origin: string
  ): Promise<{ pending: PendingOnesa; code: string } | null> {
    return this.serialize(async () => {
      const raw = await this.store.read();
      if (!raw) return null;
      const pending: PendingOnesa = JSON.parse(raw);
      let code: string;
      try {
        code = nativeCode(incoming, pending, origin);
      } catch (error) {
        // Only a denial already matched to this attempt ends it on a cold start.
        if (error instanceof Error && error.message === "onesa_denied")
          await this.store.remove();
        throw error;
      }
      await this.store.remove();
      return { pending, code };
    });
  }
}
