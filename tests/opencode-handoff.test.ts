/** 限流交接：摘要里不能带旧会话序号。 */

import { describe, expect, it } from "vitest";
import {
  formatOpencodeTranscript,
  handoffPrompt,
  localDigest,
  scrubIds,
} from "../src/opencode-handoff.ts";

describe("opencode 交接摘要", () => {
  it("抽出用户、助手和工具文本，不带消息号", () => {
    const text = formatOpencodeTranscript({
      data: [
        {
          id: "msg_user",
          type: "user",
          content: [{ type: "text", text: "先看 README" }],
        },
        {
          id: "msg_assistant",
          type: "assistant",
          content: [
            { type: "text", text: "README 说要改测试" },
            {
              type: "tool",
              name: "read",
              input: { filePath: "README.md" },
              output: "测试在 tests/",
            },
          ],
        },
      ],
    });

    expect(text).toContain("用户：先看 README");
    expect(text).toContain("README 说要改测试");
    expect(text).toContain("[工具 read]");
    expect(text).toContain("测试在 tests/");
    expect(text).not.toContain("msg_");
  });

  it("新会话提示只保留摘要和当前请求", () => {
    const prompt = handoffPrompt(scrubIds("旧会话 ses_abc 做到一半"), "继续");

    expect(prompt).toContain("全新的会话");
    expect(prompt).toContain("做到一半");
    expect(prompt).toContain("[当前用户消息]\n继续");
    expect(prompt).not.toContain("ses_abc");
  });

  it("过长记录只留头尾", () => {
    const digest = localDigest(`${"头".repeat(9_000)}中${"尾".repeat(4_000)}`);
    expect(digest.startsWith("头")).toBe(true);
    expect(digest.endsWith("尾")).toBe(true);
    expect(digest).toContain("…");
    expect(digest.length).toBeLessThan(13_000);
  });
});
