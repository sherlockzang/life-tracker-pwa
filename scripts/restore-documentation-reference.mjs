import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Documentation contains source snapshots, never cloud data or secrets.
export const referenceNames = ["SCHEMA", "EDGE", "DOMAIN", "FRONTEND", "ASSET"].map(name => `${name}-REFERENCE.md`);

export function readReference(directory) {
  const result = new Map();
  for (const name of referenceNames) {
    const text = readFileSync(resolve(directory, name), "utf8");
    const pattern = /^<!-- source: (.+) sha256: ([a-f0-9]{64}) encoding: (utf8|base64) -->\n\x60{4}[^\n]*\n([\s\S]*?)\n\x60{4}$/gm;
    for (const match of text.matchAll(pattern)) {
      const [, path, expected, encoding, body] = match;
      if (isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === ".." || part === ".") || path.startsWith(".git/") || path.includes(".env.local")) throw new Error(`Unsafe snapshot path: ${path}`);
      if (result.has(path)) throw new Error(`Duplicate snapshot path: ${path}`);
      const bytes = Buffer.from(body, encoding === "base64" ? "base64" : "utf8");
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) throw new Error(`Corrupt reference: ${path}`);
      result.set(path, { bytes, sha256: actual });
    }
  }
  if (result.size < 70 || !result.has("src/App.tsx") || !result.has("package-lock.json") || !result.has("supabase/config.toml")) throw new Error("Incomplete reference bundle");
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const docs = resolve(value("--reference") || "docs/reference");
  const entries = readReference(docs);
  if (!args.includes("--write")) {
    console.log(`Verified ${entries.size} files. Dry run only; use --out NEW_DIRECTORY --write to restore.`);
  } else {
    const requested = value("--out");
    if (!requested || requested.startsWith("--")) throw new Error("--out NEW_DIRECTORY is required");
    const destination = resolve(requested);
    if (existsSync(destination)) throw new Error("Refusing to overwrite an existing directory");
    mkdirSync(destination, { recursive: true });
    for (const [path, { bytes }] of entries) {
      const output = resolve(destination, path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes, { flag: "wx" });
    }
    console.log(`Restored ${entries.size} files into ${destination}. No cloud operations performed.`);
  }
}
