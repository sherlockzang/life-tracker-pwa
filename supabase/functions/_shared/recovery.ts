// Result-recovery tokens carry already-returned content, not credentials. They
// are authenticated, scoped and short-lived; the caller must also bind userId.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid recovery token");
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error("Noncanonical recovery token");
  return bytes;
}

async function signingKey(secret: string) {
  if (!secret) throw new Error("Missing recovery signing secret");
  return crypto.subtle.importKey("raw", encoder.encode(`life-tracker:recovery:v1:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signRecoveryToken<T extends Record<string, unknown>>(payload: T, scope: string, secret: string, now = Date.now(), ttlMs = 30 * 60_000) {
  if (!scope || ttlMs <= 0 || ttlMs > 30 * 60_000) throw new Error("Invalid recovery scope or lifetime");
  const body = encode(encoder.encode(JSON.stringify({ version: 1, scope, issuedAt: now, expiresAt: now + ttlMs, payload })));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(body));
  return `${body}.${encode(new Uint8Array(signature))}`;
}

export async function verifyRecoveryToken<T>(token: string, scope: string, secret: string, now = Date.now()): Promise<T> {
  if (token.length > 64_000) throw new Error("Invalid recovery token");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid recovery token");
  const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), decode(parts[1]), encoder.encode(parts[0]));
  if (!valid) throw new Error("Invalid recovery signature");
  const envelope = JSON.parse(decoder.decode(decode(parts[0]))) as { version?: number; scope?: string; issuedAt?: number; expiresAt?: number; payload?: T };
  if (envelope.version !== 1 || envelope.scope !== scope || !Number.isFinite(envelope.issuedAt) || !Number.isFinite(envelope.expiresAt)
    || envelope.issuedAt! > now + 30_000 || envelope.expiresAt! <= now || envelope.expiresAt! - envelope.issuedAt! > 30 * 60_000 || !envelope.payload) {
    throw new Error("Expired or invalid recovery token");
  }
  return envelope.payload;
}
