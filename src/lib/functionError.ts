export async function edgeFunctionMessage(error: unknown, fallback: string) {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.clone === "function") {
    try {
      const body = await context.clone().json() as { error?: { message?: unknown } };
      if (typeof body?.error?.message === "string" && body.error.message.trim()) return body.error.message.trim();
    } catch {
      // Keep the user-facing fallback for non-JSON upstream failures.
    }
  }
  return fallback;
}

