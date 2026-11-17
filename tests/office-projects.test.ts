import { describe, expect, it } from "vitest";
import { projectActivity, rootOf } from "../src/client/office/projects.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const sub = (parent: string, extra: object = {}) => ({ parentSessionId: parent, origin: "subagent", updatedAt: NOW - HOUR, ...extra });

describe("项目忙闲总览（含子代理）", () => {
  const state = {
    byId: {
      L1: { updatedAt: NOW - HOUR },
      m1: sub("L1", { running: true }),
      m2: sub("L1"),
      m1x: sub("m1", { running: true }), // 组员派的子代理
      oldKid: sub("L1", { updatedAt: NOW - 30 * HOUR }), // 早就结束的子代理：不算人
      a: { cwd: "/p/notes", running: true, updatedAt: NOW },
      ax: sub("a", { running: true }), // 单智能体派的子代理
      b: { cwd: "/p/notes", updatedAt: NOW - HOUR },
      c: { cwd: "/p/paper", updatedAt: NOW - HOUR },
      fork: { parentSessionId: "c", cwd: "/p/paper", updatedAt: NOW - HOUR }, // 普通分叉：独立会话
    },
  };
  it("沿子代理链归到顶层会话；普通分叉是独立会话", () => {
    expect(rootOf(state.byId, "m1x")).toBe("L1");
    expect(rootOf(state.byId, "ax")).toBe("a");
    expect(rootOf(state.byId, "fork")).toBe("fork");
  });
  it("团队 = 组长 + 整棵子代理树里 24 小时内活跃的，在跑的含组员派的子代理", () => {
    expect(projectActivity(state, ["L1"], [], NOW).teams.L1).toEqual({ total: 4, running: 2 });
  });
  it("单智能体项目连同它们的子代理，按文件夹分组；共享办公室合计", () => {
    const act = projectActivity(state, [], ["a", "b", "c", "fork"], NOW);
    expect(act.soloProjects).toEqual([
      { cwd: "/p/notes", ids: ["a", "b"], total: 3, running: 2 },
      { cwd: "/p/paper", ids: ["c", "fork"], total: 2, running: 0 },
    ]);
    expect(act.shared).toEqual({ total: 5, running: 2 });
  });
});
