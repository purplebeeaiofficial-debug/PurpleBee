import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { postJson } from "./api.js";
import { collectHardwareProfile, collectRuntimeStatus } from "./hardware.js";
import { calculateContributedMinutes, isWithinReservation } from "./scheduler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.resolve(__dirname, "../config.json");
const workerPath = path.resolve(__dirname, "../../worker/python_task_runner.py");

if (!fs.existsSync(configPath)) {
  throw new Error("config.json is missing. Copy config.example.json to config.json first.");
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const state = {
  contributorId: null,
  sessionStartedAt: null,
};

async function register() {
  const hardware = await collectHardwareProfile();
  const response = await postJson(config.serverBaseUrl, "/api/contributors/register", {
    userId: config.userId,
    deviceName: config.deviceName,
    caps: config.caps,
    hardware,
  });
  state.contributorId = response.contributor.id;

  if (config.reservation?.startsAt && config.reservation?.endsAt) {
    await postJson(config.serverBaseUrl, "/api/contributors/reservations", {
      userId: config.userId,
      contributorId: state.contributorId,
      startsAt: config.reservation.startsAt,
      endsAt: config.reservation.endsAt,
    });
  }

  console.log("[Contributor] registered:", state.contributorId);
}

function runPythonTask(task) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `python-worker-failed:${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(JSON.stringify(task));
    child.stdin.end();
  });
}

async function heartbeatLoop() {
  if (!state.contributorId) return;
  const runtime = await collectRuntimeStatus();
  await postJson(config.serverBaseUrl, "/api/contributors/heartbeat", {
    contributorId: state.contributorId,
    status: runtime.idleAssumed ? "idle" : "busy",
    runtime,
  });
}

async function claimLoop() {
  if (!state.contributorId) return;
  const now = Date.now();
  const withinReservation = isWithinReservation(now, config.reservation);
  if (!withinReservation) {
    if (state.sessionStartedAt) {
      const rawMinutes = calculateContributedMinutes(state.sessionStartedAt, now);
      state.sessionStartedAt = null;
      if (rawMinutes > 0) {
        const hardware = await collectHardwareProfile();
        await postJson(config.serverBaseUrl, "/api/contributors/credit", {
          userId: config.userId,
          rawMinutes,
          hardware,
        });
        await postJson(config.serverBaseUrl, "/api/subscriptions/evaluate", {
          userId: config.userId,
        });
      }
    }
    return;
  }

  const runtime = await collectRuntimeStatus();
  if (!runtime.idleAssumed) return;

  if (!state.sessionStartedAt) {
    state.sessionStartedAt = new Date().toISOString();
  }

  const taskResponse = await postJson(config.serverBaseUrl, "/api/work/claim", {
    userId: config.userId,
    contributorId: state.contributorId,
    premium: true,
  });

  if (!taskResponse.task) return;
  const task = taskResponse.task;
  try {
    const result = await runPythonTask(task);
    await postJson(config.serverBaseUrl, `/api/work/${task.id}/complete`, {
      ok: true,
      result,
    });
    console.log("[Contributor] completed task:", task.id, task.type);
  } catch (error) {
    await postJson(config.serverBaseUrl, `/api/work/${task.id}/complete`, {
      ok: false,
      result: { error: String(error?.message || error) },
    });
    console.error("[Contributor] task failed:", task.id, error);
  }
}

async function main() {
  await register();
  await heartbeatLoop();
  await claimLoop();

  setInterval(() => {
    heartbeatLoop().catch((error) => console.error("[Contributor] heartbeat failed:", error));
  }, Number(config.heartbeatIntervalMs || 30000));

  setInterval(() => {
    claimLoop().catch((error) => console.error("[Contributor] claim loop failed:", error));
  }, Number(config.claimIntervalMs || 20000));
}

main().catch((error) => {
  console.error("[Contributor] fatal:", error);
  process.exit(1);
});
