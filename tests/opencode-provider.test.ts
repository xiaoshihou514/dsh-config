/** opencode 经本地代理接入：零配置目录兜底与适配器解析。 */

import { describe, expect, it } from "vitest";
import { PROVIDER, createOpencodeAdapter } from "../src/opencode-provider.ts";

describe("OpenCode 代理适配器", () => {
  it("代理不可达时目录回落内置 free 清单", async () => {
    const models = await createOpencodeAdapter().listModels(PROVIDER);
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-v4.1-flash-free",
      "mimo-v2.5-free",
      "x-preview-f-free",
    ]);
    expect(models.every((model) => model.provider === PROVIDER)).toBe(true);
  });

  it("resolveModel 声明上下文容量、默认输出上限与推理等级", async () => {
    const adapter = createOpencodeAdapter();
    const resolved = await adapter.resolveModel(
      PROVIDER,
      "deepseek-v4.1-flash-free",
    );
    expect(resolved).toMatchObject({
      provider: PROVIDER,
      id: "deepseek-v4.1-flash-free",
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 32_000,
    });
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toContain(
      "high",
    );
  });
});
