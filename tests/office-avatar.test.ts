import { describe, expect, it } from "vitest";
import { PERSONA_AVATARS } from "../src/client/office/avatars.generated.ts";
import { avatarFor } from "../src/client/office/SessionAvatar.tsx";
import type { Vendor } from "../src/office/types.ts";

const VENDORS: Vendor[] = ["claude", "gpt", "gemini", "grok", "kimi", "qwen", "glm", "deepseek", "other"];

describe("对话界面角色头像", () => {
  it("每家都有内联头像", () => {
    for (const vendor of VENDORS) expect(PERSONA_AVATARS[vendor]).toMatch(/^data:image\/png;base64,/);
  });

  it("按模型认厂商，转售渠道以模型名为准", () => {
    expect(avatarFor({ provider: "deepseek-official", model: "deepseek-flash" }, false).vendor).toBe("deepseek");
    expect(avatarFor({ provider: "opencodex", model: "anthropic/claude-opus-5-5" }, false).vendor).toBe("claude");
    expect(avatarFor({ provider: "zai-coding-cn", model: "glm-5.3" }, false).vendor).toBe("glm");
    expect(avatarFor({ provider: "opencodex", model: "cursor/kimi-k3" }, false).vendor).toBe("kimi");
  });

  it("没有模型时是兜帽旅人；默认模型在提示里注明", () => {
    expect(avatarFor(undefined, true)).toEqual({ vendor: "other", title: "未知模型" });
    expect(avatarFor({ provider: "x", model: "mystery-1" }, false).vendor).toBe("other");
    expect(avatarFor({ provider: "deepseek-official", model: "deepseek-flash" }, true).title).toContain("默认模型");
    expect(avatarFor({ provider: "deepseek-official", model: "deepseek-flash" }, false).title).not.toContain("默认模型");
  });
});
