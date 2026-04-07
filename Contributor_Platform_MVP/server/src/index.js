import cors from "cors";
import express from "express";
import { makeId, ensureLedger, ensurePenalty, ensureSubscription, ensureUser, store } from "./store.js";
import { canContribute, registerMissedReservation } from "./logic/penalties.js";
import { claimTask, completeTask, seedTasks } from "./logic/queue.js";
import { creditContribution, evaluateSubscription } from "./logic/subscription.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

seedTasks();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "purple-bee-contributor-server",
    time: new Date().toISOString(),
    tasks: Array.from(store.tasks.values()).length,
  });
});

app.post("/api/contributors/register", (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const deviceName = String(req.body?.deviceName || "Contributor Device").trim();
  const hardware = req.body?.hardware || {};
  if (!userId) {
    res.status(400).json({ ok: false, error: "userId-required" });
    return;
  }

  ensureUser(userId);
  ensureSubscription(userId);
  ensureLedger(userId);
  ensurePenalty(userId);

  const contributorId = makeId("contrib");
  const contributor = {
    id: contributorId,
    userId,
    deviceName,
    hardware,
    caps: req.body?.caps || { cpuMaxPercent: 70, gpuMaxPercent: 70 },
    lastHeartbeatAt: new Date().toISOString(),
    status: "registered",
  };
  store.contributors.set(contributorId, contributor);
  res.json({ ok: true, contributor });
});

app.post("/api/contributors/heartbeat", (req, res) => {
  const contributorId = String(req.body?.contributorId || "").trim();
  const contributor = store.contributors.get(contributorId);
  if (!contributor) {
    res.status(404).json({ ok: false, error: "contributor-not-found" });
    return;
  }
  contributor.lastHeartbeatAt = new Date().toISOString();
  contributor.status = req.body?.status || "idle";
  contributor.runtime = req.body?.runtime || {};
  res.json({ ok: true, contributor });
});

app.post("/api/contributors/reservations", (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const contributorId = String(req.body?.contributorId || "").trim();
  const startsAt = String(req.body?.startsAt || "").trim();
  const endsAt = String(req.body?.endsAt || "").trim();
  if (!userId || !contributorId || !startsAt || !endsAt) {
    res.status(400).json({ ok: false, error: "reservation-fields-required" });
    return;
  }

  const reservationId = makeId("reserve");
  const reservation = {
    id: reservationId,
    userId,
    contributorId,
    startsAt,
    endsAt,
    status: "scheduled",
    createdAt: new Date().toISOString(),
  };
  store.reservations.set(reservationId, reservation);
  res.json({ ok: true, reservation });
});

app.post("/api/work/claim", (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const contributorId = String(req.body?.contributorId || "").trim();
  const premium = Boolean(req.body?.premium);
  if (!userId || !contributorId) {
    res.status(400).json({ ok: false, error: "userId-and-contributorId-required" });
    return;
  }

  const permission = canContribute(userId);
  if (!permission.allowed) {
    res.status(403).json({ ok: false, error: permission.reason, penalty: permission.penalty });
    return;
  }

  const task = claimTask({ userId, contributorId, premium });
  res.json({ ok: true, task });
});

app.post("/api/work/:taskId/complete", (req, res) => {
  const taskId = req.params.taskId;
  const ok = Boolean(req.body?.ok);
  const result = req.body?.result || null;
  const task = completeTask(taskId, result, ok);
  if (!task) {
    res.status(404).json({ ok: false, error: "task-not-found" });
    return;
  }
  const userId = String(task.assignedUserId || "").trim();
  if (userId) {
    const ledger = ensureLedger(userId);
    if (ok) ledger.completedJobs += 1;
    else ledger.failedJobs += 1;
  }
  res.json({ ok: true, task });
});

app.post("/api/contributors/credit", (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  const rawMinutes = Number(req.body?.rawMinutes || 0);
  if (!userId || rawMinutes <= 0) {
    res.status(400).json({ ok: false, error: "userId-and-rawMinutes-required" });
    return;
  }
  const credit = creditContribution(
    userId,
    rawMinutes,
    req.body?.hardware || {},
    ensurePenalty(userId),
  );
  res.json({ ok: true, credit });
});

app.post("/api/subscriptions/evaluate", (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  if (!userId) {
    res.status(400).json({ ok: false, error: "userId-required" });
    return;
  }
  const result = evaluateSubscription(userId);
  res.json({ ok: true, result, subscription: ensureSubscription(userId) });
});

app.post("/api/penalties/miss", (req, res) => {
  const userId = String(req.body?.userId || "").trim();
  if (!userId) {
    res.status(400).json({ ok: false, error: "userId-required" });
    return;
  }
  const penalty = registerMissedReservation(userId, req.body?.reason || "missed-reservation");
  res.json({ ok: true, penalty });
});

app.get("/api/users/:userId/status", (req, res) => {
  const userId = String(req.params.userId || "").trim();
  ensureUser(userId);
  res.json({
    ok: true,
    user: store.users.get(userId),
    subscription: ensureSubscription(userId),
    ledger: ensureLedger(userId),
    penalty: ensurePenalty(userId),
    reservations: Array.from(store.reservations.values()).filter((item) => item.userId === userId),
  });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`[Purple Bee Contributor Server] listening on ${port}`);
});
