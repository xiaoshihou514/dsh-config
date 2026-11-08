import { describe, expect, it } from "vitest";
import { slackRoutines, type SlackWhere } from "../src/office-scene/slack.ts";
import type { Vendor } from "../src/office/types.ts";

const VENDORS: Vendor[] = ["claude", "gpt", "gemini", "grok", "kimi", "qwen", "glm", "deepseek", "other"];
const WHERE: SlackWhere[] = ["desk", "sofa", "stand"];

describe("办公室摸鱼动作", () => {
  it("每家在工位、沙发、站着三种场合都有动作，且至少一个是专属动作", () => {
    for (const vendor of VENDORS)
      for (const where of WHERE) {
        const list = slackRoutines(vendor, where);
        expect(list.length, `${vendor}/${where}`).toBeGreaterThan(0);
        expect(list.some((r) => r.id !== "stretch" && r.id !== "coffee"), `${vendor}/${where}`).toBe(true);
      }
  });

  it("同一场合里动作 id 不重复，气泡文字非空", () => {
    for (const vendor of VENDORS)
      for (const where of WHERE) {
        const list = slackRoutines(vendor, where);
        expect(new Set(list.map((r) => r.id)).size).toBe(list.length);
        for (const r of list) expect(r.label.trim().length).toBeGreaterThan(0);
      }
  });
});
