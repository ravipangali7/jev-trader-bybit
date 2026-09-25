import { restSignPayload, sign } from "./sign.ts";

export class BybitError extends Error {
  constructor(
    public retCode: number,
    message: string,
  ) {
    super(message);
    this.name = "BybitError";
  }
}

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

export class BybitRest {
  constructor(
    private opts: {
      base: string;
      apiKey?: string;
      apiSecret?: string;
      recvWindow?: string;
    },
  ) {}

  get hasKeys(): boolean {
    return Boolean(this.opts.apiKey && this.opts.apiSecret);
  }

  async publicGet<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const qs = queryString(query);
    const url = `${this.opts.base}${path}${qs ? `?${qs}` : ""}`;
    return this.parse<T>(await fetch(url, { headers: { accept: "application/json" } }), `${path}`);
  }

  async privateGet<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const qs = queryString(query);
    const { headers } = this.authHeaders(qs);
    const url = `${this.opts.base}${path}${qs ? `?${qs}` : ""}`;
    return this.parse<T>(await fetch(url, { headers }), path);
  }

  async privatePost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify(body);
    const { headers } = this.authHeaders(payload);
    return this.parse<T>(
      await fetch(`${this.opts.base}${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: payload,
      }),
      path,
    );
  }

  private authHeaders(payload: string): { headers: Record<string, string> } {
    const apiKey = this.opts.apiKey ?? "";
    const secret = this.opts.apiSecret ?? "";
    if (!apiKey || !secret) throw new Error("private Bybit call without API keys");
    const timestamp = Date.now().toString();
    const recv = this.opts.recvWindow ?? "5000";
    const sig = sign(secret, restSignPayload(timestamp, apiKey, recv, payload));
    return {
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-SIGN": sig,
        "X-BAPI-RECV-WINDOW": recv,
        accept: "application/json",
      },
    };
  }

  private async parse<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      throw new BybitError(res.status, `Bybit ${what} HTTP ${res.status}: ${text.slice(0, 180)}`);
    }
    let body: BybitEnvelope<T>;
    try {
      body = JSON.parse(text) as BybitEnvelope<T>;
    } catch {
      throw new BybitError(res.status, `Bybit ${what} did not return JSON: ${text.slice(0, 180)}`);
    }
    if (body.retCode !== 0) throw new BybitError(body.retCode, `Bybit ${what} ${body.retCode} ${body.retMsg}`);
    return body.result;
  }
}

function queryString(query: Record<string, string>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") u.append(k, v);
  return u.toString();
}

/** One in-flight chain so two symbols cannot burst past the cap. */
export class RateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private next = 0;

  constructor(private perSec: number) {}

  take(): Promise<void> {
    const run = this.tail.then(async () => {
      const gap = 1000 / this.perSec;
      const now = Date.now();
      const at = Math.max(now, this.next);
      this.next = at + gap;
      const wait = at - now;
      if (wait > 0) await Bun.sleep(wait);
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
