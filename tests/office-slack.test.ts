import { describe, expect, it } from "vitest";
import { slackRoutines, type SlackPlace, type SlackWhere } from "../src/office-scene/slack.ts";
import type { Vendor } from "../src/office/types.ts";

const VENDORS: Vendor[] = ["claude", "gpt", "gemini", "grok", "kimi", "qwen", "glm", "deepseek", "other"];
const WHERE: SlackWhere[] = ["desk", "sofa", "stand"];
/** 办公室里实际出现的（场合, 去处）组合。 */
const SPOTS: [SlackWhere, SlackPlace][] = [
  ["desk", "desk"],
  ["sofa", "sofa"],
  ["stand", "lounge"],
  ["stand", "shelf"],
  ["stand", "window"],
  ["stand", "wall"],
  ["stand", "open"],
  ["stand", "plant"],
  ["stand", "lead"],
];

describe("办公室摸鱼动作", () => {
  it("每家在工位、沙发、站着三种场合都有动作，且至少一个是专属动作", () => {
    for (const vendor of VENDORS)
      for (const where of WHERE) {
        const list = slackRoutines(vendor, where);
        expect(list.length, `${vendor}/${where}`).toBeGreaterThan(0);
        expect(list.some((r) => r.id !== "stretch" && r.id !== "coffee"), `${vendor}/${where}`).toBe(true);
      }
  });

  it("每家在每个去处都至少有 3 个动作可轮换", () => {
    for (const vendor of VENDORS)
      for (const [where, place] of SPOTS)
        expect(slackRoutines(vendor, where, place).length, `${vendor}/${where}/${place}`).toBeGreaterThanOrEqual(3);
  });

  it("去处专属动作只在对应去处出现", () => {
    const ids = (place: SlackPlace) => slackRoutines("claude", "stand", place).map((r) => r.id);
    expect(ids("shelf")).toContain("shelf-hunt");
    expect(ids("window")).not.toContain("shelf-hunt");
    expect(ids("plant")).toContain("plant-water");
    expect(ids("shelf")).not.toContain("plant-water");
    expect(slackRoutines("claude", "desk", "desk").map((r) => r.id)).toContain("desk-music");
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
