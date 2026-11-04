import { describe, expect, it } from "vitest";
import { NavGrid, type P2 } from "../src/office-scene/nav.ts";

const room = { x0: -5, x1: 5, z0: -5, z1: 5 };
/** 路径上按小步采样，确认都在空地上。 */
function walkable(nav: NavGrid, from: P2, path: readonly P2[]): boolean {
  let prev = from;
  for (const p of path) {
    if (!nav.lineFree(prev, p)) return false;
    prev = p;
  }
  return true;
}

describe("办公室寻路", () => {
  it("空房间直线走到，不绕弯", () => {
    const nav = new NavGrid(room);
    expect(nav.find([-3, 0], [3, 0])).toEqual([[3, 0]]);
  });

  it("绕过中间的墙，路径拉直成少量拐点且全程在空地上", () => {
    const nav = new NavGrid(room);
    nav.setObstacles([{ x0: -0.5, x1: 0.5, z0: -4, z1: 3 }]);
    const path = nav.find([-3, 0], [3, 0])!;
    expect(path).not.toBeNull();
    expect(path.at(-1)).toEqual([3, 0]);
    expect(path.length).toBeLessThanOrEqual(4);
    expect(walkable(nav, [-3, 0], path)).toBe(true);
    // 从缺口（z > 3）那边绕
    expect(path.some(([, z]) => z > 3)).toBe(true);
  });

  it("起点在障碍里时先就近挪到空地；封死时返回 null", () => {
    const nav = new NavGrid(room);
    nav.setObstacles([{ x0: -1, x1: 1, z0: -1, z1: 1 }]);
    const path = nav.find([0, 0], [3, 3])!;
    expect(nav.isFree(path[0]![0], path[0]![1])).toBe(true);
    nav.setObstacles([{ x0: -0.3, x1: 0.3, z0: -6, z1: 6 }]);
    expect(nav.find([-3, 0], [3, 0])).toBeNull();
  });
});
