/** opencode v2 接入：零配置目录兜底与适配器解析。 */

import { describe, expect, it } from "vitest";
import { PROVIDER, createOpencodeAdapter } from "../src/opencode-provider.ts";

describe("OpenCode v2 适配器", () => {
  it("后端不可达时目录回落内置 free 清单", async () => {
    const models = await createOpencodeAdapter().listModels(PROVIDER);
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-v4.1-flash-free",
      "glm-5.3-flash-free",
      "mimo-v2.6-flash-free",
      "flint-40b-free",
      "nemotron-3.5-super-vl-free",
      "nemotron-3.5-lightning-free",
      "beam-free",
    ]);
    expect(models.every((model) => model.provider === PROVIDER)).toBe(true);
  });

  it("resolveModel 声明上下文容量、默认输出上限与推理等级", async () => {
    const adapter = createOpencodeAdapter();
    const resolved = await adapter.resolveModel(
      PROVIDER,
      "opencode/deepseek-v4.1-flash-free",
    );
    expect(resolved).toMatchObject({
      provider: PROVIDER,
      id: "opencode/deepseek-v4.1-flash-free",
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 32_000,
    });
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toContain(
      "high",
    );
  });
});
