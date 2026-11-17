import { describe, expect, it } from "vitest";
import { bossOf, bossSnapshot, pickLeads, type LeadFacts } from "../src/client/office/boss.ts";
import { bossStateOf } from "../src/office/boss.ts";
import type { OfficeMember } from "../src/office/types.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

describe("老板办公室：状态判定", () => {
  const ok = { at: NOW, ok: true };
  const bad = { at: NOW, ok: false };
  it("组员在跑、组长没在干活（或卡在等组员）→ 等组员", () => {
    expect(bossStateOf({ leadRunning: false, leadWaiting: false, membersRunning: true })).toBe("waiting");
    expect(bossStateOf({ leadRunning: true, leadWaiting: true, membersRunning: true })).toBe("waiting");
  });
  it("组长自己在干活 → 不来", () => {
    expect(bossStateOf({ leadRunning: true, leadWaiting: false, membersRunning: true })).toBeNull();
    expect(bossStateOf({ leadRunning: true, leadWaiting: false, membersRunning: false, lastTurn: ok })).toBeNull();
  });
  it("全队停下、组长这一轮结束 → 按成败汇报 / 出错；没开过一轮不来", () => {
    expect(bossStateOf({ leadRunning: false, leadWaiting: false, membersRunning: false, lastTurn: ok })).toBe("report");
    expect(bossStateOf({ leadRunning: false, leadWaiting: false, membersRunning: false, lastTurn: bad })).toBe("error");
    expect(bossStateOf({ leadRunning: false, leadWaiting: false, membersRunning: false })).toBeNull();
  });
});

describe("老板办公室：挑组长", () => {
  it("团队列表里的组长与有子会话的会话，只留 24 小时内团队有活动的，最近的在前", () => {
    const state = {
      byId: {
        fresh: { updatedAt: NOW - HOUR },
        old: { updatedAt: NOW - 30 * HOUR },
        oldKid: { parentSessionId: "old", running: true, updatedAt: NOW - 30 * HOUR },
        stale: { updatedAt: NOW - 40 * HOUR },
        staleKid: { parentSessionId: "stale", updatedAt: NOW - 40 * HOUR },
        nested: { parentSessionId: "oldKid", updatedAt: NOW },
        solo: { updatedAt: NOW },
      },
    };
    // old：组长自己 30 小时没动，但组员正在跑 → 算活跃，排最前；fresh 只在团队列表里（还没招人）
    expect(pickLeads(state, new Set(["fresh"]), NOW)).toEqual(["old", "fresh"]);
  });
});

describe("老板办公室：以浏览器在跑状态为准", () => {
  const member = {
    id: "L",
    name: "组长",
    role: "lead",
    phase: "active",
    vendor: "claude",
    tier: "flagship",
    roleKind: "lead",
    busy: false,
    lastTurn: { at: NOW, ok: true },
    stats: { turns: 1, steps: 1, toolCalls: 0, sent: 0, received: 0, outputTokens: 0 },
    cwd: "/p/shop",
  } as OfficeMember;
  const facts: LeadFacts = { member, leadWaiting: false, memberIds: ["A", "B"], membersRunning: true };
  it("浏览器知道组员都停了，就不再算等组员", () => {
    expect(bossOf(facts, {})).toBe("waiting");
    expect(bossOf(facts, { A: false, B: false })).toBe("report");
    expect(bossOf(facts, { L: true, A: false })).toBeNull();
  });
  it("快照只放有事的组长，待处理在前，带项目名", () => {
    const busy: LeadFacts = { ...facts, member: { ...member, id: "M", lastTurn: undefined }, memberIds: ["C"] };
    const snap = bossSnapshot([busy, facts], { A: false, B: false, C: true }, (cwd) => cwd?.split("/").pop() ?? "");
    expect(snap?.members.map((m) => [m.id, m.boss, m.project])).toEqual([
      ["L", "report", "shop"],
      ["M", "waiting", "shop"],
    ]);
  });
});
