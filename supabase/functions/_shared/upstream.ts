// A fetch promise resolves when headers arrive, not when the body is read.
// Keep one hard deadline over both phases. The explicit rejection also settles
// the caller when an injected/custom transport ignores AbortSignal entirely.
export async function fetchJsonWithTimeout<T>(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<{ response: Response; payload: T }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid upstream deadline");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("Upstream response deadline exceeded", "AbortError"));
    }, timeoutMs);
  });
  const read = (async () => {
    let response: Response;
    try { response = await fetch(input, { ...init, signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") throw new DOMException("Upstream request aborted", "AbortError");
      // Transport errors can embed the request URL (including access_key),
      // headers or provider diagnostics. Never propagate them to API logging.
      throw new Error("Upstream request failed");
    }
    let value: unknown;
    try { value = await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw new DOMException("Upstream response deadline exceeded", "AbortError");
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Preserve existing handlers' semantics for malformed provider JSON:
      // they inspect an empty payload and report their normal upstream error.
      value = {};
    }
    // These endpoints expect an object envelope. Valid JSON null, primitives or
    // arrays are still invalid provider envelopes, not internal TypeErrors.
    const payload = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as T;
    return { response, payload };
  })();
  try { return await Promise.race([read, deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
