import { openDB, type DBSchema } from "idb";
import type { ExchangeRate, LifeRecord, Trip, UserSettings } from "../types";

export interface Snapshot {
  userId: string;
  records: LifeRecord[];
  trips: Trip[];
  rates: ExchangeRate[];
  settings: UserSettings;
  savedAt: string;
}

export interface PendingMutation {
  id: string;
  table: "records" | "trips" | "user_settings" | "exchange_rates";
  operation: "upsert" | "delete";
  payload: Record<string, unknown>;
  createdAt: string;
}

interface LifeTrackerDB extends DBSchema {
  snapshots: {
    key: string;
    value: Snapshot;
  };
  outbox: {
    key: string;
    value: PendingMutation;
    indexes: { "by-created": string };
  };
}

const dbPromise = openDB<LifeTrackerDB>("life-tracker", 1, {
  upgrade(db) {
    db.createObjectStore("snapshots", { keyPath: "userId" });
    const outbox = db.createObjectStore("outbox", { keyPath: "id" });
    outbox.createIndex("by-created", "createdAt");
  }
});

export async function loadSnapshot(userId: string) {
  return (await dbPromise).get("snapshots", userId);
}

export async function saveSnapshot(snapshot: Snapshot) {
  return (await dbPromise).put("snapshots", snapshot);
}

export async function queueMutation(mutation: Omit<PendingMutation, "id" | "createdAt">) {
  const item: PendingMutation = {
    ...mutation,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString()
  };
  await (await dbPromise).put("outbox", item);
  return item;
}

export async function listMutations() {
  return (await dbPromise).getAllFromIndex("outbox", "by-created");
}

export async function removeMutation(id: string) {
  return (await dbPromise).delete("outbox", id);
}
