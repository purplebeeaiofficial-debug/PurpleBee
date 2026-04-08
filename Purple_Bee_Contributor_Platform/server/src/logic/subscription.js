import { ensureLedger, ensureSubscription, ensureUser } from "../store.js";

export function computeHardwareTier(hardware = {}) {
  const memoryGb = Number(hardware.memoryGb || 0);
  const cpuThreads = Number(hardware.cpuThreads || 0);
  const gpuScore = Number(hardware.gpuScore || 0);

  if (memoryGb >= 16 && cpuThreads >= 10) {
    return { tier: "high", multiplier: gpuScore > 0 ? 1.5 : 1.4 };
  }
  if (memoryGb >= 8 && cpuThreads >= 6) {
    return { tier: "standard", multiplier: 1.0 };
  }
  return { tier: "low", multiplier: 0.8 };
}

export function computeReliabilityMultiplier(penalty = {}) {
  const efficiencyPenalty = Number(penalty.efficiencyPenalty || 1);
  return Math.max(0.4, Math.min(1, efficiencyPenalty));
}

export function creditContribution(userId, rawMinutes, hardwareInfo, penaltyInfo) {
  const user = ensureUser(userId);
  const ledger = ensureLedger(userId);
  const subscription = ensureSubscription(userId);
  const hardware = computeHardwareTier(hardwareInfo);
  const reliability = computeReliabilityMultiplier(penaltyInfo);
  const effectiveMinutes = Math.round(Number(rawMinutes || 0) * hardware.multiplier * reliability);

  ledger.rawMinutes += Number(rawMinutes || 0);
  ledger.effectiveMinutes += effectiveMinutes;
  user.hardwareTier = hardware.tier;

  return {
    userId,
    rawMinutes: Number(rawMinutes || 0),
    effectiveMinutes,
    hardwareTier: hardware.tier,
    multiplier: hardware.multiplier,
    reliability,
    subscriptionStatus: subscription.status,
  };
}

export function evaluateSubscription(userId) {
  const ledger = ensureLedger(userId);
  const subscription = ensureSubscription(userId);
  const available = ledger.effectiveMinutes - ledger.consumedEffectiveMinutes;
  const now = Date.now();

  let awardedDays = 0;
  let consumed = 0;

  if (available >= 300) {
    awardedDays = 7;
    consumed = 300;
  } else if (available >= 60) {
    awardedDays = 1;
    consumed = 60;
  }

  if (!awardedDays) {
    return {
      awardedDays: 0,
      premiumUntil: subscription.premiumUntil,
      availableEffectiveMinutes: available,
    };
  }

  const baseTime = subscription.premiumUntil
    ? Math.max(new Date(subscription.premiumUntil).getTime(), now)
    : now;
  const nextUntil = new Date(baseTime + awardedDays * 24 * 60 * 60 * 1000).toISOString();

  ledger.consumedEffectiveMinutes += consumed;
  subscription.status = "premium";
  subscription.activatedAt = new Date(now).toISOString();
  subscription.premiumUntil = nextUntil;
  subscription.source = "contributor-subscription";

  return {
    awardedDays,
    consumedEffectiveMinutes: consumed,
    premiumUntil: nextUntil,
    availableEffectiveMinutes: ledger.effectiveMinutes - ledger.consumedEffectiveMinutes,
  };
}
