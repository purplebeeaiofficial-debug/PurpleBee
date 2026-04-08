import { ensurePenalty } from "../store.js";

export function registerMissedReservation(userId, reason = "missed-reservation") {
  const penalty = ensurePenalty(userId);
  penalty.missCount += 1;
  penalty.warnings.push({
    at: new Date().toISOString(),
    reason,
  });

  if (penalty.missCount === 1) {
    penalty.efficiencyPenalty = 0.9;
  } else if (penalty.missCount === 2) {
    penalty.efficiencyPenalty = 0.75;
    penalty.restrictionUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  } else if (penalty.missCount >= 3) {
    penalty.efficiencyPenalty = 0.5;
    penalty.restrictionUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  return penalty;
}

export function clearExpiredPenalty(userId) {
  const penalty = ensurePenalty(userId);
  if (penalty.restrictionUntil && new Date(penalty.restrictionUntil).getTime() <= Date.now()) {
    penalty.restrictionUntil = null;
  }
  return penalty;
}

export function canContribute(userId) {
  const penalty = clearExpiredPenalty(userId);
  if (!penalty.restrictionUntil) return { allowed: true, penalty };
  return {
    allowed: false,
    penalty,
    reason: "restricted",
  };
}
