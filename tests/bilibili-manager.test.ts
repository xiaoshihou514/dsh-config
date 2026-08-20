import { describe, expect, it } from "vitest";
import { DownloadManager } from "../src/bilibili/download/manager.ts";
import { DownloadTask } from "../src/bilibili/download/task.ts";

/** 受控任务：run 挂起，外部决定何时放行。 */
function controlledTask(
  id: string,
  opts: {
    onStart?: () => void;
    onAbort?: () => void;
    onEnd?: () => void;
  } = {},
): { task: DownloadTask; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = new DownloadTask({
    id,
    artifact: "audio",
    title: `任务 ${id}`,
    targetPath: `/tmp/${id}.m4a`,
    run: async (signal) => {
      try {
        opts.onStart?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            opts.onAbort?.();
            resolve();
          });
          void gate.then(() => {
            if (!signal.aborted) resolve();
          });
        });
      } finally {
        opts.onEnd?.();
      }
    },
  });
  return { task, release };
}

describe("DownloadManager", () => {
  it("并发 1：任务串行执行，全部进入历史", async () => {
    const manager = new DownloadManager({ concurrency: 1 });
    let running = 0;
    let maxRunning = 0;
    const a = controlledTask("a", {
      onStart: () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
      },
      onEnd: () => {
        running -= 1;
      },
    });
    const b = controlledTask("b", {
      onStart: () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
      },
      onEnd: () => {
        running -= 1;
      },
    });
    manager.enqueue(a.task);
    manager.enqueue(b.task);
    // 第一个任务开始后，第二个必须仍在排队
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(a.task.state).toBe("downloading");
    expect(b.task.state).toBe("queued");
    a.release();
    await a.task.settled;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(b.task.state).toBe("downloading");
    b.release();
    await b.task.settled;
    expect(a.task.state).toBe("done");
    expect(b.task.state).toBe("done");
    expect(manager.history().map((r) => r.id).sort()).toEqual(["a", "b"]);
    // 任意时刻最多 1 个活跃
    expect(maxRunning).toBe(1);
  });

  it("取消排队中的任务：直接 canceled，不进历史", async () => {
    const manager = new DownloadManager({ concurrency: 1 });
    const a = controlledTask("a");
    const b = controlledTask("b");
    manager.enqueue(a.task);
    manager.enqueue(b.task);
    expect(manager.cancel("b")).toBe(true);
    expect(b.task.state).toBe("canceled");
    await b.task.settled;
    a.release();
    await a.task.settled;
    expect(a.task.state).toBe("done");
    // 仅 a 入历史
    expect(manager.history().map((r) => r.id)).toEqual(["a"]);
  });

  it("取消下载中的任务：abort 后状态为 canceled", async () => {
    const manager = new DownloadManager({ concurrency: 1 });
    const a = controlledTask("a");
    manager.enqueue(a.task);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(a.task.state).toBe("downloading");
    manager.cancel("a");
    await a.task.settled;
    expect(a.task.state).toBe("canceled");
  });

  it("remove：任务从注册表消失", async () => {
    const manager = new DownloadManager({ concurrency: 1 });
    const a = controlledTask("a");
    manager.enqueue(a.task);
    expect(manager.remove("a")).toBe(true);
    expect(manager.list()).toHaveLength(0);
    expect(manager.remove("missing")).toBe(false);
  });

  it("并发 2：两个任务可同时活跃", async () => {
    const manager = new DownloadManager({ concurrency: 2 });
    let running = 0;
    let maxRunning = 0;
    const a = controlledTask("a", {
      onStart: () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
      },
      onEnd: () => {
        running -= 1;
      },
    });
    const b = controlledTask("b", {
      onStart: () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
      },
      onEnd: () => {
        running -= 1;
      },
    });
    manager.enqueue(a.task);
    manager.enqueue(b.task);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(a.task.state).toBe("downloading");
    expect(b.task.state).toBe("downloading");
    expect(maxRunning).toBe(2);
    a.release();
    b.release();
    await Promise.all([a.task.settled, b.task.settled]);
    expect(a.task.state).toBe("done");
    expect(b.task.state).toBe("done");
  });
});
