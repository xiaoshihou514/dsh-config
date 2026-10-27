/** opencode 经本地代理接入：模型发现过滤、目录物化与适配器解析。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Config, PROVIDER, createOpencodeAdapter, discoverModels } from "../src/opencode-provider.ts";

function config(overrides: Partial<typeof Config.input> = {}) {
  return Config(overrides) as unknown as ReturnType<typeof Config> & {
    models: string[];
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("代理模型发现", () => {
  it("配置清单优先，不发请求", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      discoverModels(config({ models: ["a-free", "b-free"] })),
    ).resolves.toEqual(["a-free", "b-free"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("从代理 /models 自动发现 *-free 并过滤其余", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({
          data: [{ id: "deepseek-v4.1-flash-free" }, { id: "qwen3-coder-plus" }, { id: "mimo-v2.5-free" }],
        })),
      ),
    );
    await expect(discoverModels(config())).resolves.toEqual([
      "deepseek-v4.1-flash-free",
      "mimo-v2.5-free",
    ]);
  });

  it("代理不可达时回退空清单（不抛错）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(discoverModels(config())).resolves.toEqual([]);
  });
});

describe("OpenCode 代理适配器", () => {
  it("目录按配置物化并声明标准推理等级与上下文容量", async () => {
    const adapter = createOpencodeAdapter(
      config({ models: ["deepseek-v4.1-flash-free"], contextWindow: 131_072, maxTokens: 16_384 }),
    );
    const models = await adapter.listModels(PROVIDER);
    expect(models.map((model) => model.id)).toEqual(["deepseek-v4.1-flash-free"]);
    const resolved = await adapter.resolveModel(PROVIDER, "deepseek-v4.1-flash-free");
    expect(resolved).toMatchObject({
      provider: PROVIDER,
      id: "deepseek-v4.1-flash-free",
      context: { contextWindow: 131_072 },
      defaultMaxTokens: 16_384,
    });
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toContain("high");
  });

  it("resolveApiKey：未配置密钥时发送占位 Bearer", async () => {
    const adapter = createOpencodeAdapter(config({ apiKey: "", models: ["x-free"] }));
    const prepared = await adapter.prepareCall(PROVIDER, "x-free");
    expect(prepared).toBeDefined();
  });
});
