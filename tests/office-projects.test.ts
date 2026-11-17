import { describe, expect, it } from "vitest";
import { busyUnits, projectActivity, unitOf } from "../src/client/office/projects.ts";

const sub = (parent: string, extra: object = {}) => ({ parentSessionId: parent, origin: "subagent", ...extra });

describe("项目忙闲：单位只有组长、组员、单智能体，子代理只让派它的单位亮", () => {
  const state = {
    byId: {
      L1: {},
      m1: sub("L1"), // 组员（在名册里）
      m2: sub("L1"),
      m1x: sub("m1", { running: true }), // 组员派的子代理在跑 → 组员 m1 在跑
      lx: sub("L1"), // 组长派的子代理（不在名册），空闲
      lxx: sub("lx", { running: true }), // 子代理的子代理在跑 → 组长在跑
      a: { cwd: "/p/notes" },
      ax: sub("a", { running: true }), // 单智能体派的子代理在跑 → a 在跑
      b: { cwd: "/p/notes", running: true },
      c: { cwd: "/p/paper" },
    },
  };
  const teams = [{ leadId: "L1", memberIds: ["m1", "m2"] }];
  it("沿子代理链找最近的单位", () => {
    const units = new Set(["L1", "m1", "m2", "a"]);
    expect(unitOf(state.byId, "m1x", units)).toBe("m1");
    expect(unitOf(state.byId, "lxx", units)).toBe("L1");
    expect(unitOf(state.byId, "ax", units)).toBe("a");
    expect([...busyUnits(state, units)].sort()).toEqual(["L1", "a", "m1"]);
  });
  it("团队人手 = 组长 + 名册组员，子代理不占位", () => {
    expect(projectActivity(state, teams, []).teams.L1).toEqual({ total: 3, running: 2, leadOn: true });
  });
  it("单智能体项目按文件夹分组，子代理不占位；共享办公室合计", () => {
    const act = projectActivity(state, teams, ["a", "b", "c"]);
    expect(act.soloProjects).toEqual([
      { cwd: "/p/notes", ids: ["a", "b"], total: 2, running: 2 },
      { cwd: "/p/paper", ids: ["c"], total: 1, running: 0 },
    ]);
    expect(act.shared).toEqual({ total: 3, running: 2 });
  });
});
