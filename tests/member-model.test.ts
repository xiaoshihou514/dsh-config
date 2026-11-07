import { describe, expect, it } from "vitest";
import { digestSession, type LooseEvent } from "../src/office/derive.ts";
import { parseSelection } from "../src/office/member-model.ts";

let seq = 0;
const ev = (type: string, data: unknown): LooseEvent => ({ type, seq: seq++, time: 1000 + seq, data });
const header = (provider: string, model: string, reasoningEffort?: string) =>
  ev("request/header", { header: { config: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } } });

describe("成员模型推导", () => {
  it("创建时的模型 → 手动换的模型优先显示 → 请求用上后以请求为准", () => {
    const base = [ev("subagent/descriptor", { agentProvider: "zai", agentModel: "glm-5.3", agentReasoningEffort: "high" })];
    expect(digestSession("M", base)).toMatchObject({ provider: "zai", model: "glm-5.3", reasoningEffort: "high" });

    const switched = [...base, header("zai", "glm-5.3", "high"), ev("model/selection", { provider: "opencodex", model: "opus" })];
    expect(digestSession("M", switched)).toMatchObject({ provider: "opencodex", model: "opus", reasoningEffort: undefined });

    // 换之前已发出的那一步的回复不应把显示改回旧模型
    const inflight = [...switched, ev("assistant/message", { message: { source: { provider: "zai", model: "glm-5.3" } } })];
    expect(digestSession("M", inflight)).toMatchObject({ provider: "opencodex", model: "opus" });

    const used = [...inflight, header("opencodex", "opus", "xhigh")];
    expect(digestSession("M", used)).toMatchObject({ provider: "opencodex", model: "opus", reasoningEffort: "xhigh" });
  });
});

describe("parseSelection", () => {
  it("校验成员、模型与推理强度", () => {
    expect(parseSelection({ member: "m", provider: " p ", model: "x" })).toEqual({ member: "m", selection: { provider: "p", model: "x" } });
    expect(parseSelection({ member: "m", provider: "p", model: "x", reasoningEffort: "high" })).toEqual({
      member: "m",
      selection: { provider: "p", model: "x", reasoningEffort: "high" },
    });
    expect(parseSelection({ member: "m", provider: "p", model: "x", reasoningEffort: null })).toEqual({ member: "m", selection: { provider: "p", model: "x" } });
    expect(parseSelection({ provider: "p", model: "x" })).toBe("缺少 member");
    expect(parseSelection({ member: "m", provider: "p" })).toBe("缺少 provider / model");
    expect(parseSelection({ member: "m", provider: "p", model: "x", reasoningEffort: 3 })).toBe("reasoningEffort 不合法");
    expect(parseSelection([1])).toBe("请求体不是对象");
  });
});
