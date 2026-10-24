/** Minimal JSON-RPC client with retries. We only need a handful of methods, so no provider library. */
export class Rpc {
  readonly url: string;
  private id = 0;

  constructor(url: string) {
    this.url = url;
  }

  async call<T>(method: string, params: unknown[], retries = 7): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (body.error) throw new RpcError(method, body.error.code, body.error.message);
        return body.result as T;
      } catch (err) {
        // Errors returned by the node (bad params, reverts) are deterministic; don't retry them.
        if (err instanceof RpcError) throw err;
        lastError = err;
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 8000)));
      }
    }
    throw lastError;
  }
}

export class RpcError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.code = code;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. Preserves order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
