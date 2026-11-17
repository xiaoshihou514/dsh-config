import { describe, expect, it } from "vitest";
import { projectActivity } from "../src/client/office/projects.ts";

describe("项目忙闲总览", () => {
  const state = {
    byId: {
      L1: { running: false },
      k1: { parentSessionId: "L1", running: true },
      k2: { parentSessionId: "L1", running: true },
      L2: { running: false },
      k3: { parentSessionId: "L2", running: false },
      a: { cwd: "/p/notes", running: true },
      b: { cwd: "/p/notes", running: false },
      c: { cwd: "/p/paper", running: false },
      d: { cwd: "/p/shop", running: false },
      e: { cwd: "/p/shop", running: false },
    },
  };
  it("团队：组长与子会话里在跑的个数", () => {
    expect(projectActivity(state, ["L1", "L2"], []).teamRunning).toEqual({ L1: 2, L2: 0 });
  });
  it("单智能体按文件夹分组：在跑的项目在前，其次人多的在前", () => {
    const { soloProjects } = projectActivity(state, [], ["c", "a", "d", "b", "e"]);
    expect(soloProjects).toEqual([
      { cwd: "/p/notes", ids: ["a", "b"], running: 1 },
      { cwd: "/p/shop", ids: ["d", "e"], running: 0 },
      { cwd: "/p/paper", ids: ["c"], running: 0 },
    ]);
  });
});
