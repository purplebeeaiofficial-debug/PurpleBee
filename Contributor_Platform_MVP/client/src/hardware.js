import os from "node:os";
import si from "systeminformation";

export async function collectHardwareProfile() {
  const [cpu, mem, graphics, fsSize] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.graphics(),
    si.fsSize(),
  ]);

  const totalDisk = (fsSize || []).reduce((sum, item) => sum + Number(item.size || 0), 0);
  const freeDisk = (fsSize || []).reduce((sum, item) => sum + Number(item.available || 0), 0);

  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpu?.brand || "unknown",
    cpuThreads: Number(cpu?.cores || os.cpus().length || 0),
    memoryGb: Math.round((Number(mem?.total || 0) / (1024 ** 3)) * 10) / 10,
    gpuModel: graphics?.controllers?.[0]?.model || "unknown",
    gpuScore: graphics?.controllers?.length ? 1 : 0,
    diskTotalGb: Math.round((totalDisk / (1024 ** 3)) * 10) / 10,
    diskFreeGb: Math.round((freeDisk / (1024 ** 3)) * 10) / 10,
  };
}

export async function collectRuntimeStatus() {
  const load = await si.currentLoad();
  return {
    cpuUsagePercent: Math.round(Number(load?.currentLoad || 0)),
    idleAssumed: Number(load?.currentLoad || 0) < 35,
  };
}
