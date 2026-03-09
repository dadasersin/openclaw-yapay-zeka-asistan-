/**
 * Local subscription state store.
 * Persists Stripe subscription info to ~/.openclaw/billing/subscriptions.json.
 * This is updated by the Stripe webhook handler when subscription events arrive.
 */

import path from "node:path";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { resolveStateDir } from "../config/paths.js";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused"
  | "inactive";

export type SubscriptionRecord = {
  version: 1;
  customerId: string;
  subscriptionId: string;
  status: SubscriptionStatus;
  /** Unix timestamp (seconds) when the current period ends */
  currentPeriodEnd: number;
  /** ISO timestamp when last updated */
  updatedAt: string;
};

type SubscriptionStore = {
  version: 1;
  subscriptions: SubscriptionRecord[];
};

function resolveStorePath(): string {
  return path.join(resolveStateDir(), "billing", "subscriptions.json");
}

function loadStore(): SubscriptionStore {
  const raw = loadJsonFile(resolveStorePath());
  if (
    raw &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>).version === 1 &&
    Array.isArray((raw as Record<string, unknown>).subscriptions)
  ) {
    return raw as SubscriptionStore;
  }
  return { version: 1, subscriptions: [] };
}

function saveStore(store: SubscriptionStore): void {
  saveJsonFile(resolveStorePath(), store);
}

/** Upsert a subscription record keyed by customerId. */
export function upsertSubscription(record: Omit<SubscriptionRecord, "version">): void {
  const store = loadStore();
  const idx = store.subscriptions.findIndex((s) => s.customerId === record.customerId);
  const full: SubscriptionRecord = { version: 1, ...record };
  if (idx >= 0) {
    store.subscriptions[idx] = full;
  } else {
    store.subscriptions.push(full);
  }
  saveStore(store);
}

/** Mark a subscription as canceled/inactive by customerId or subscriptionId. */
export function deactivateSubscription(params: {
  customerId?: string;
  subscriptionId?: string;
}): void {
  const store = loadStore();
  for (const sub of store.subscriptions) {
    if (
      (params.customerId && sub.customerId === params.customerId) ||
      (params.subscriptionId && sub.subscriptionId === params.subscriptionId)
    ) {
      sub.status = "canceled";
      sub.updatedAt = new Date().toISOString();
    }
  }
  saveStore(store);
}

/** Returns the first active subscription record, if any. */
export function getActiveSubscription(): SubscriptionRecord | undefined {
  const store = loadStore();
  const now = Math.floor(Date.now() / 1000);
  return store.subscriptions.find(
    (s) =>
      (s.status === "active" || s.status === "trialing") && s.currentPeriodEnd > now,
  );
}

/** Returns all subscription records. */
export function getAllSubscriptions(): SubscriptionRecord[] {
  return loadStore().subscriptions;
}
