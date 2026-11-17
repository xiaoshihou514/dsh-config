import { describe, expect, it } from "vitest";
import { SOLO_CAP, SOLO_WINDOW_MS, pickSolo, type SessionRowLike } from "../src/client/office/shared.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function list(rows: Record<string, SessionRowLike>) {
  return { ids: Object.keys(rows), byId: rows };
}

describe("共享办公室入选", () => {
  it("只要顶层、非空白、在跑或 24 小时内活跃的单智能体", () => {
    const state = list({
      run: { running: true, updatedAt: NOW - 5 * 24 * HOUR },
      recent: { updatedAt: NOW - 2 * HOUR },
      stale: { updatedAt: NOW - SOLO_WINDOW_MS - HOUR },
      blank: { blank: true, updatedAt: NOW },
      child: { parentSessionId: "lead", origin: "subagent", updatedAt: NOW },
      lead: { updatedAt: NOW },
    });
    expect(pickSolo(state, new Set(), NOW).ids).toEqual(["run", "recent"]);
  });

  it("组长双重排除：有子会话的、在团队列表里的（刚组建还没招人）", () => {
    const state = list({
      withKids: { updatedAt: NOW },
      kid: { parentSessionId: "withKids", updatedAt: NOW },
      fresh: { running: true, updatedAt: NOW },
      solo: { updatedAt: NOW - HOUR },
    });
    expect(pickSolo(state, new Set(["fresh"]), NOW).ids).toEqual(["solo"]);
  });

  it("在跑的优先，其次最近活跃；超出座位数只计数", () => {
    const rows: Record<string, SessionRowLike> = {};
    for (let i = 0; i < SOLO_CAP + 3; i += 1) rows[`s${i}`] = { updatedAt: NOW - i * 1000 };
    rows.late = { running: true, updatedAt: NOW - 20 * HOUR };
    const { ids, overflow } = pickSolo(list(rows), new Set(), NOW);
    expect(ids).toHaveLength(SOLO_CAP);
    expect(ids[0]).toBe("late");
    expect(ids[1]).toBe("s0");
    expect(overflow).toBe(4);
  });

  it("宿主时间是秒也能认", () => {
    const state = list({ sec: { updatedAt: Math.floor((NOW - HOUR) / 1000) } });
    expect(pickSolo(state, new Set(), NOW).ids).toEqual(["sec"]);
  });
});
