import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import deepseekAssist from "../deepseek-assist/index.ts";

// Backward-compatible v1.2 route endpoint. It now delegates to the v1.3
// assistant so older installed PWAs receive the same quota and safety rules.
export default {
  async fetch(request: Request) {
    if (request.method === "OPTIONS") return deepseekAssist.fetch(request);
    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // The shared handler returns the canonical validation response.
    }
    const nextRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify({ ...body, action: "route", requestId: crypto.randomUUID() })
    });
    return deepseekAssist.fetch(nextRequest);
  }
};
