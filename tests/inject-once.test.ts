import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { apply, injectionCause, renderInjectOnce } from "../src/inject-once.ts";

const injection = (cause: "session-start" | "compaction") =>
  ({
    type: "user/message",
    data: { source: { kind: "inject-once", cause }, content: [] },
  }) as never;

const compact = (error?: string) =>
  ({
    type: "compaction/end",
    data: {
      compactionId: "compact-1",
      turn: 1,
      ...(error === undefined ? {} : { error }),
    },
  }) as never;

describe("单次提醒触发边界", () => {
  it("首次请求注入，普通后续请求不重复", () => {
    expect(injectionCause([])).toEqual({ cause: "session-start" });
    expect(injectionCause([injection("session-start")])).toBeUndefined();
  });

  it("成功压缩后再注入一次，失败压缩不触发", () => {
    expect(injectionCause([injection("session-start"), compact()])).toEqual({
      cause: "compaction",
      compactionId: "compact-1",
    });
    expect(
      injectionCause([
        injection("session-start"),
        compact(),
        injection("compaction"),
      ]),
    ).toBeUndefined();
    expect(
      injectionCause([injection("session-start"), compact("失败")]),
    ).toBeUndefined();
  });

  it("全局提醒排在项目 AGENTS.md 之前", () => {
    expect(renderInjectOnce("先检查测试", "遵守项目格式")).toBe(
      "全局提醒：\n\n先检查测试\n\n项目 AGENTS.md：\n\n遵守项目格式",
    );
  });

  it("在真实 pre-step 钩子中读取项目根目录并只追加一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-inject-once-"));
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".git"));
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "项目规则");
    let listener:
      | ((payload: any, next: () => Promise<any>) => Promise<any>)
      | undefined;
    const ctx = {
      settings: { register: () => ({ get: () => ({ prompt: "全局规则" }) }) },
      // 本测试无 webServer 服务：get 返回 undefined 走"跳过路由注册"分支，effect 置为空操作
      get: () => undefined,
      effect: () => undefined,
      on: (event: string, hook: typeof listener) => {
        if (event === "agent/pre-step") listener = hook;
      },
    };
    apply(ctx as never, { prompt: "全局规则" });
    const prompt = createUserMessage({
      content: [{ type: "text", text: "开始" }],
      source: { kind: "user" },
    });
    const agent = { session: { header: { cwd: nested }, events: [] } };
    const next = () => Promise.resolve({ kind: "enter", messages: [prompt] });

    const first = await listener?.(
      { agent, signal: new AbortController().signal },
      next,
    );
    expect(first.messages).toHaveLength(2);
    expect(first.messages[1].content[0].text).toBe(
      "全局提醒：\n\n全局规则\n\n项目 AGENTS.md：\n\n项目规则",
    );
    expect(first.messages[1].source).toEqual({
      kind: "inject-once",
      cause: "session-start",
    });

    agent.session.events.push({
      type: "user/message",
      data: first.messages[1],
    } as never);
    const second = await listener?.(
      { agent, signal: new AbortController().signal },
      next,
    );
    expect(second.messages).toEqual([prompt]);
  });
});
