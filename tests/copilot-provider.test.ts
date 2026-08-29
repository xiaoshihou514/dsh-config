import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { copilotSubscriptionAccessToken } from "../src/copilot-auth.ts";
import {
  CopilotLoginManager,
  createCopilotAdapter,
  PROVIDER,
} from "../src/copilot-provider.ts";

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
