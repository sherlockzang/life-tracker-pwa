// Keyset pagination uses immutable, unique IDs, not mutable display dates or
// offsets. Continue to an empty page: a configured server cap may be < limit.
// The caller must publish/cache results only after this promise succeeds.
export async function readAllPages<T extends { id: string }>(
  page: (afterId: string | null) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < 100_000; index++) {
    const result = await page(cursor);
    if (result.error) throw result.error;
    if (!Array.isArray(result.data)) throw new Error("Incomplete collection response");
    if (!result.data.length) return rows;
    for (const row of result.data) {
      if (typeof row.id !== "string" || !row.id || (cursor !== null && row.id <= cursor)) throw new Error("Invalid collection cursor");
      rows.push(row);
      cursor = row.id;
    }
  }
  throw new Error("Collection pagination did not finish");
}
