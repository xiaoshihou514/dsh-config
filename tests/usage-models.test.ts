import { describe, expect, it } from "vitest";
import { modelGroupKey } from "../src/usage-models.ts";

describe("用量模型家族", () => {
  it("归到家族名，x-preview 和路径里的 grok 不被横线切碎", () => {
    expect(modelGroupKey("opencode-free/x-preview-f-free")).toBe("x-preview");
    expect(modelGroupKey("openai-codex/gpt-6-luna")).toBe("gpt");
    expect(modelGroupKey("github-copilot/claude-sonnet-5")).toBe("claude");
    expect(modelGroupKey("github-copilot/kimi-k3")).toBe("kimi");
    expect(modelGroupKey("deepseek-flash")).toBe("deepseek");
    expect(modelGroupKey("zai-coding-cn/glm-5.3-flash")).toBe("glm");
    expect(modelGroupKey("opencodex/cursor/grok-4.7")).toBe("grok");
    expect(modelGroupKey("opencodex/cursor/grok-4.7--fast")).toBe("grok");
    expect(
      modelGroupKey(
        "opencodex/cloudflare-workers-ai/@cf-deepseek-ai-deepseek-v4.1-flash-1017",
      ),
    ).toBe("deepseek");
  });
});
