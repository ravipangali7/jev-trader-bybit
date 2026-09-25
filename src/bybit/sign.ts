import { createHmac } from "node:crypto";

/** Bybit v5 HMAC-SHA256 hex signature. `payload` is the exact string they tell you to sign. */
export function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** REST: timestamp + apiKey + recvWindow + queryString or raw JSON body. */
export function restSignPayload(timestamp: string, apiKey: string, recvWindow: string, body: string): string {
  return `${timestamp}${apiKey}${recvWindow}${body}`;
}

/** Private WebSocket: HMAC of "GET/realtime" + expires. */
export function wsSignPayload(expires: number): string {
  return `GET/realtime${expires}`;
}
