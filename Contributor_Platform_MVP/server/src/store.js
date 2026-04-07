import { randomUUID } from "node:crypto";

export const store = {
  users: new Map(),
  contributors: new Map(),
  reservations: new Map(),
  tasks: new Map(),
  subscriptions: new Map(),
  ledger: new Map(),
  penalties: new Map(),
};

export function ensureUser(userId) {
  if (!store.users.has(userId)) {
    store.users.set(userId, {
      id: userId,
      tier: "free",
      createdAt: new Date().toISOString(),
    });
  }
  return store.users.get(userId);
}

export function ensureSubscription(userId) {
  if (!store.subscriptions.has(userId)) {
    store.subscriptions.set(userId, {
      userId,
      status: "free",
      premiumUntil: null,
      activatedAt: null,
      source: null,
    });
  }
  return store.subscriptions.get(userId);
}

export function ensureLedger(userId) {
  if (!store.ledger.has(userId)) {
    store.ledger.set(userId, {
      userId,
      rawMinutes: 0,
      effectiveMinutes: 0,
      consumedEffectiveMinutes: 0,
      completedJobs: 0,
      failedJobs: 0,
    });
  }
  return store.ledger.get(userId);
}

export function ensurePenalty(userId) {
  if (!store.penalties.has(userId)) {
    store.penalties.set(userId, {
      userId,
      missCount: 0,
      restrictionUntil: null,
      efficiencyPenalty: 1,
      warnings: [],
    });
  }
  return store.penalties.get(userId);
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID()}`;
}
