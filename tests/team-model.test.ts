import { describe, expect, it } from "vitest";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { PendingChoices, choiceGuidance, parseChoice, patchDefinition } from "../src/team-model.ts";

const ALLOWED = [
  { provider: "opencodex", model: "anthropic/claude-opus-5-5" },
  { provider: "zai-coding-cn", model: "glm-5.3" },
];

describe("parseChoice", () => {
  it("没给模型参数时不干预", () => {
    expect(parseChoice({ name: "a", description: "b" }, ALLOWED)).toBeUndefined();
    expect(parseChoice({ provider: " ", model: "" }, ALLOWED)).toBeUndefined();
  });

  it("名单内的线路通过，带推理强度", () => {
    expect(parseChoice({ provider: "opencodex", model: "anthropic/claude-opus-5-5", reasoning_effort: "high" }, ALLOWED)).toEqual({
      provider: "opencodex",
      model: "anthropic/claude-opus-5-5",
      reasoningEffort: "high",
    });
  });

  it("只给一半、名单外、未开启都报错", () => {
    expect(() => parseChoice({ model: "glm-5.3" }, ALLOWED)).toThrow(/together/);
    expect(() => parseChoice({ reasoning_effort: "high" }, ALLOWED)).toThrow(/together/);
    expect(() => parseChoice({ provider: "opencodex", model: "x" }, ALLOWED)).toThrow(/not allowed.*opencodex\/anthropic/);
    expect(() => parseChoice({ provider: "opencodex", model: "x" }, undefined)).toThrow(/disabled/);
  });
});

describe("patchDefinition", () => {
  const make = () =>
    defineTool({
      name: "spawn_teammate",
      description: "Create one teammate.",
      parameters: {
        name: { type: "string", required: true },
        description: { type: "string", required: true },
      },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
      execute: (args) => Promise.resolve(JSON.stringify(args)),
    });

  it("补上参数、说明现读名单，原工具照常执行", async () => {
    const def = make();
    let allowed = ALLOWED;
    patchDefinition(def as never, () => choiceGuidance(allowed));
    patchDefinition(def as never, () => "重复补丁不应生效");
    const properties = (def.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(["name", "description", "provider", "model", "reasoning_effort"]);
    expect(def.description).toContain("opencodex / anthropic/claude-opus-5-5");
    allowed = [ALLOWED[1]!];
    expect(def.description).not.toContain("claude");
    expect(JSON.parse(JSON.stringify(def)).description).toContain("glm-5.3");
    const out = await def.execute({ name: "a", description: "b", provider: "opencodex", model: "m" } as never, {} as never);
    expect(out).toContain('"provider":"opencodex"');
  });
});

describe("PendingChoices", () => {
  const spec = (parent: string, label: string, agentOptions?: Record<string, unknown>) => ({
    provider: "spawn",
    label,
    request: { parent: { id: parent }, prompt: [], ...(agentOptions ? { agentOptions } : {}) },
  });

  it("同一组长、同一职责的创建请求领走模型，只领一次", () => {
    const pending = new PendingChoices();
    pending.add("lead-1", " 后端开发 ", { provider: "opencodex", model: "m", reasoningEffort: "high" });
    expect(pending.apply(spec("lead-2", "后端开发")).request).not.toHaveProperty("agentOptions");
    expect(pending.apply(spec("lead-1", "前端开发")).request).not.toHaveProperty("agentOptions");
    expect(pending.apply(spec("lead-1", "后端开发")).request.agentOptions).toEqual({
      provider: "opencodex",
      model: "m",
      reasoningEffort: "high",
    });
    expect(pending.apply(spec("lead-1", "后端开发")).request).not.toHaveProperty("agentOptions");
  });

  it("已带 agentOptions 的请求不动；撤销登记后不再匹配", () => {
    const pending = new PendingChoices();
    const release = pending.add("lead", "x", { provider: "p", model: "m" });
    expect(pending.apply(spec("lead", "x", { model: "keep" })).request.agentOptions).toEqual({ model: "keep" });
    release();
    expect(pending.apply(spec("lead", "x")).request).not.toHaveProperty("agentOptions");
  });
});
