import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { copilotSubscriptionAccessToken } from "../src/copilot-auth.ts";
import {
  CopilotLoginManager,
  copilotAvailableModelIds,
  createCopilotAdapter,
  filterCopilotModels,
  PROVIDER,
} from "../src/copilot-provider.ts";

/** 模型目录样例（Claude 系代表 pi-ai 内置 Copilot 目录）。 */
const CATALOG = [
  { id: "claude-opus-5" },
  { id: "claude-sonnet-5" },
  { id: "claude-haiku-4.5" },
] as const;

function oauth(refresh: OAuthAuth["refresh"]): OAuthAuth {
  return {
    name: "测试",
    login: async () => {
      throw new Error("本测试不会登录");
    },
    refresh,
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };
}

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "copilot-session-token",
    refresh: "github-oauth-token",
    expires: 3_000_000,
    availableModelIds: ["gpt-5", "claude-sonnet-4.5"],
    ...overrides,
  };
}

describe("Copilot 订阅凭据", () => {
  it("直接复用仍有效的会话令牌", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-copilot-"));
    const authFile = join(root, "auth.json");
    const saved = credential({ access: "valid-token" });
    await writeFile(authFile, JSON.stringify(saved));
    const refresh = vi.fn<OAuthAuth["refresh"]>();

    await expect(
      copilotSubscriptionAccessToken(oauth(refresh), {
        authFile,
        now: () => 1_000_000,
      }),
    ).resolves.toBe("valid-token");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("刷新临近过期的会话令牌并回写登录文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-copilot-"));
    const authFile = join(root, "auth.json");
    await writeFile(
      authFile,
      JSON.stringify(credential({ access: "stale-token", expires: 1 })),
    );
    const next = credential({
      access: "fresh-token",
      expires: 4_000_000,
      availableModelIds: ["gpt-5"],
    });

    await expect(
      copilotSubscriptionAccessToken(
        oauth(async () => next),
        {
          authFile,
          now: () => 2_000_000,
        },
      ),
    ).resolves.toBe("fresh-token");
    const saved = JSON.parse(await readFile(authFile, "utf8")) as Record<
      string,
      any
    >;
    expect(saved).toMatchObject({
      type: "oauth",
      access: "fresh-token",
      refresh: "github-oauth-token",
      availableModelIds: ["gpt-5"],
    });
  });

  it("拒绝内容不完整的登录文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-copilot-"));
    const authFile = join(root, "auth.json");
    await writeFile(authFile, JSON.stringify({ type: "oauth" }));

    await expect(
      copilotSubscriptionAccessToken(oauth(vi.fn()), { authFile }),
    ).rejects.toThrow("不完整");
  });
});

describe("Copilot 订阅提供方", () => {
  it("向 DSH 提供 GitHub Copilot 模型目录", async () => {
    const models = await createCopilotAdapter().listModels(PROVIDER);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === PROVIDER)).toBe(true);
  });

  it("无可用清单时过滤保底全集", () => {
    const catalog = [{ id: "a" }, { id: "b" }];
    expect(filterCopilotModels(catalog, undefined)).toEqual(catalog);
    expect(copilotAvailableModelIds(join(tmpdir(), "不存在-dsh-copilot"))).toBeUndefined();
  });

  it("按凭据回写的 availableModelIds 过滤目录（模型分级）", () => {
    const available = new Set(["claude-sonnet-5", "claude-haiku-4.5"]);
    expect(filterCopilotModels(CATALOG, available).map((m) => m.id)).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4.5",
    ]);
  });

  it("从凭据文件读取账户可用模型清单", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-copilot-models-"));
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = root;
    try {
      await mkdir(join(root, "copilot"), { recursive: true });
      await writeFile(
        join(root, "copilot", "auth.json"),
        JSON.stringify(credential({ availableModelIds: ["claude-sonnet-5"] })),
      );
      expect(copilotAvailableModelIds()).toEqual(new Set(["claude-sonnet-5"]));
      // 空清单视为无信息（保底全集而非空目录）。
      await writeFile(
        join(root, "copilot", "auth.json"),
        JSON.stringify(credential({ availableModelIds: [] })),
      );
      expect(copilotAvailableModelIds()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("适配器目录按凭据清单收窄（端到端）", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-copilot-adapter-"));
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = root;
    try {
      const full = await createCopilotAdapter().listModels(PROVIDER);
      expect(full.length).toBeGreaterThan(1);
      await mkdir(join(root, "copilot"), { recursive: true });
      await writeFile(
        join(root, "copilot", "auth.json"),
        JSON.stringify(
          credential({ availableModelIds: [full[0]?.id ?? ""] }),
        ),
      );
      const narrowed = await createCopilotAdapter().listModels(PROVIDER);
      expect(narrowed.map((model) => model.id)).toEqual([full[0]?.id]);
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("可在 DSH 内发起设备码登录并保存凭据", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-copilot-login-"));
    const authFile = join(root, "auth.json");
    const next = credential();
    const loginOAuth = oauth(async (current) => current);
    loginOAuth.login = async (interaction) => {
      // 企业域名询问被自动回空串（github.com 个人版）。
      await expect(
        interaction.prompt({
          type: "text",
          message: "GitHub Enterprise URL/domain (blank for github.com)",
        }),
      ).resolves.toBe("");
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
      });
      return next;
    };
    const manager = new CopilotLoginManager(loginOAuth, authFile);

    await expect(manager.start()).resolves.toMatchObject({
      state: "pending",
      url: "https://github.com/login/device",
      userCode: "ABCD-1234",
    });
    await vi.waitFor(() =>
      expect(manager.status()).toEqual({ state: "success" }),
    );
    const saved = JSON.parse(await readFile(authFile, "utf8")) as Record<
      string,
      any
    >;
    expect(saved).toMatchObject({
      type: "oauth",
      access: next.access,
      refresh: next.refresh,
      availableModelIds: ["gpt-5", "claude-sonnet-4.5"],
    });
  });
});
