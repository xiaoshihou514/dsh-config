import { describe, expect, it } from "vitest";
import { roleKindOf, tierOf, vendorOf } from "../src/office/classify.ts";
import { assembleSnapshot, digestSession, type LooseEvent } from "../src/office/derive.ts";

let seq = 0;
const ev = (type: string, data: unknown, time = 1000 + seq): LooseEvent => ({ type, seq: seq++, time, data });

describe("模型与岗位分类", () => {
  it("按模型名区分厂商与档位", () => {
    expect([vendorOf("opencodex", "anthropic/claude-opus-5-5"), tierOf("anthropic/claude-opus-5-5")]).toEqual(["claude", "flagship"]);
    expect([vendorOf("cursor", "gpt-5.6-luna"), tierOf("gpt-5.6-luna")]).toEqual(["gpt", "fast"]);
    expect([vendorOf("zai-coding-cn", "glm-5.3-flash"), tierOf("glm-5.3-flash")]).toEqual(["glm", "fast"]);
    expect(tierOf("glm-5.3")).toBe("flagship");
    expect(tierOf("claude-fable-5-1")).toBe("flagship");
    expect(vendorOf("x", "muse-spark-1.3")).toBe("other");
  });
  it("按名字与描述识别岗位", () => {
    expect(roleKindOf("teammate", "backend-dev", "Rust/Tauri 后端")).toBe("backend");
    expect(roleKindOf("teammate", "frontend-dev", "Vue 前端")).toBe("frontend");
    expect(roleKindOf("teammate", "alice", "代码审查")).toBe("reviewer");
    expect(roleKindOf("lead", "lead", undefined)).toBe("lead");
  });
});

describe("团队快照推导", () => {
  it("汇总名册、交流、当前动作与待办", () => {
    seq = 0;
    const lead = digestSession("L", [
      ev("user/message", { content: [{ type: "text", text: "组建团队" }], source: { kind: "user" } }),
      ev("request/header", { header: { config: { provider: "zai-coding-cn", model: "glm-5.3" } } }),
      ev("team/member", { member: { id: "B", name: "backend-dev", description: "后端", phase: "provisioning" } }),
      ev("team/member", { member: { id: "B", name: "backend-dev", description: "后端", phase: "active" } }),
      ev("todo/write", { todos: [{ content: "摸底", status: "in_progress" }] }),
      ev("user/message", {
        content: [{ type: "text", text: "Team message from backend-dev:" }, { type: "text", text: "报告完成" }],
        source: { kind: "agent-message", senderSessionId: "B" },
      }),
      ev("step/start", { turn: 1, step: 2 }),
      ev("tool/call", { callId: "c1", name: "wait_agent", arguments: "{}" }),
    ]);
    const member = digestSession(
      "B",
      [
        ev("subagent/descriptor", { agentProvider: "zai-coding-cn", agentModel: "glm-5.3-flash" }),
        ev("user/message", { content: [{ type: "text", text: "你是后端" }], source: { kind: "user" } }),
        ev("step/start", { turn: 1, step: 1 }),
        ev("tool/call", { callId: "c2", name: "bash", arguments: JSON.stringify({ description: "运行测试", command: "cargo test" }) }),
        ev("tool/result", { message: { toolCallId: "c2", isError: true } }),
        ev("step/end", {}),
        ev("turn/end", { reason: { kind: "completed" } }),
      ],
      "L",
    );
    const snap = assembleSnapshot({
      leadId: "L",
      lead,
      members: new Map([["B", member]]),
      loaded: new Set(["L"]),
      now: 0,
    });
    expect(snap.members.map((m) => [m.name, m.roleKind, m.vendor, m.tier])).toEqual([
      ["lead", "lead", "glm", "flagship"],
      ["backend-dev", "backend", "glm", "fast"],
    ]);
    expect(snap.members[0]!.busy).toBe(true);
    expect(snap.members[0]!.current).toMatchObject({ kind: "waiting", label: "等待组员进展" });
    expect(snap.members[1]!.busy).toBe(false);
    expect(member.activity.find((a) => a.tool === "bash")).toMatchObject({ label: "运行测试", failed: true });
    expect(snap.interactions.map((i) => [i.kind, i.from, i.to, i.preview])).toEqual([
      ["instruction", "user", "L", "组建团队"],
      ["message", "B", "L", "报告完成"],
      ["spawn", "L", "B", "你是后端"],
    ]);
    expect(snap.taskSource).toBe("todo");
    expect(snap.tasks[0]).toMatchObject({ subject: "摸底", status: "in_progress" });
  });
});

describe("最近一轮的结束", () => {
  it("记录结束时间与是否成功，新开一轮后清掉", () => {
    seq = 0;
    const done = digestSession("L", [
      ev("turn/start", {}, 100),
      ev("turn/end", { reason: { kind: "completed" } }, 200),
    ]);
    expect(done.lastTurn).toEqual({ at: 200, ok: true });
    const failed = digestSession("L", [
      ev("turn/start", {}, 100),
      ev("turn/end", { reason: { kind: "error" } }, 300),
    ]);
    expect(failed.lastTurn).toEqual({ at: 300, ok: false, reason: "error" });
    const again = digestSession("L", [
      ev("turn/start", {}, 100),
      ev("turn/end", { reason: { kind: "completed" } }, 200),
      ev("turn/start", {}, 400),
    ]);
    expect(again.lastTurn).toBeUndefined();
  });
});

describe("成员手动指定", () => {
  it("覆盖岗位 / 人设 / 档位，组长岗位固定，并保留自动识别结果", async () => {
    const { applyOverrides } = await import("../src/agent-office.ts");
    seq = 0;
    const lead = digestSession("L", [
      ev("request/header", { header: { config: { provider: "zai-coding-cn", model: "glm-5.3" } } }),
      ev("team/member", { member: { id: "B", name: "helper", description: "", phase: "active" } }),
    ]);
    const snap = assembleSnapshot({ leadId: "L", lead, members: new Map(), loaded: new Set(), now: 0 });
    const out = applyOverrides(snap, { B: { role: "qa", vendor: "kimi" }, L: { role: "qa", tier: "fast" } });
    expect(out.members[1]).toMatchObject({ roleKind: "qa", vendor: "kimi", detected: { roleKind: "general", vendor: "other" } });
    expect(out.members[1]!.overridden).toEqual({ role: true, vendor: true, tier: false });
    expect(out.members[0]).toMatchObject({ roleKind: "lead", tier: "fast" });
    expect(out.members[0]!.overridden?.role).toBe(false);
  });
});
