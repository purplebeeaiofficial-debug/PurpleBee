import { makeId, store } from "../store.js";

export function seedTasks() {
  if (store.tasks.size) return;
  const tasks = [
    {
      id: makeId("task"),
      queue: "standard",
      type: "preprocess_text",
      payload: {
        text: "Purple Bee는 기여 기반 구독 모델을 실험하고 있습니다. 이 문장을 전처리하세요.",
      },
      status: "queued",
      retries: 0,
      assignedTo: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: makeId("task"),
      queue: "premium",
      type: "summarize_stub",
      payload: {
        text: "A contributor subscription system rewards users who provide idle compute in scheduled windows.",
      },
      status: "queued",
      retries: 0,
      assignedTo: null,
      createdAt: new Date().toISOString(),
    },
  ];

  for (const task of tasks) {
    store.tasks.set(task.id, task);
  }
}

export function claimTask({ userId, contributorId, premium }) {
  const ordered = Array.from(store.tasks.values())
    .filter((task) => task.status === "queued")
    .sort((a, b) => {
      const rankA = a.queue === "premium" ? 0 : 1;
      const rankB = b.queue === "premium" ? 0 : 1;
      if (premium && rankA !== rankB) return rankA - rankB;
      if (!premium && rankA !== rankB) return rankB - rankA;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  const task = ordered[0];
  if (!task) return null;

  task.status = "running";
  task.assignedTo = contributorId;
  task.assignedUserId = userId;
  task.claimedAt = new Date().toISOString();
  return task;
}

export function completeTask(taskId, result, ok = true) {
  const task = store.tasks.get(taskId);
  if (!task) return null;
  task.status = ok ? "completed" : "failed";
  task.result = result;
  task.completedAt = new Date().toISOString();
  return task;
}
