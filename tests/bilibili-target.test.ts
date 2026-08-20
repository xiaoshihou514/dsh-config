import { describe, expect, it } from "vitest";
import { parseTarget } from "../src/bilibili/api/view.ts";

describe("parseTarget：B 站目标解析", () => {
  it("bvid 直接识别（大小写不敏感）", () => {
    expect(parseTarget("BV1xx411c7mD")).toEqual({ kind: "video", bvid: "BV1xx411c7mD" });
    expect(parseTarget("bv1xx411c7md")).toEqual({ kind: "video", bvid: "bv1xx411c7md" });
  });

  it("av 号识别", () => {
    expect(parseTarget("av170001")).toEqual({ kind: "video", aid: 170001 });
    expect(parseTarget("AV170001")).toEqual({ kind: "video", aid: 170001 });
  });

  it("ep / ss 识别为番剧", () => {
    expect(parseTarget("ep123456")).toEqual({ kind: "bangumi", epId: 123456 });
    expect(parseTarget("ss43210")).toEqual({ kind: "bangumi", seasonId: 43210 });
  });

  it("uid 识别", () => {
    expect(parseTarget("uid208259")).toEqual({ kind: "user", mid: 208259 });
  });

  it("视频 URL 提取 bvid", () => {
    expect(parseTarget("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.337")).toEqual({
      kind: "video",
      bvid: "BV1GJ411x7h7",
    });
  });

  it("av URL 提取 aid", () => {
    expect(parseTarget("https://www.bilibili.com/video/av170001?p=2")).toEqual({
      kind: "video",
      aid: 170001,
    });
  });

  it("番剧 URL 提取 ep_id", () => {
    expect(parseTarget("https://www.bilibili.com/bangumi/play/ep123456")).toEqual({
      kind: "bangumi",
      epId: 123456,
    });
  });

  it("番剧 URL 提取 ss_id", () => {
    expect(parseTarget("https://www.bilibili.com/bangumi/play/ss43210")).toEqual({
      kind: "bangumi",
      seasonId: 43210,
    });
  });

  it("空间 URL 提取 uid", () => {
    expect(parseTarget("https://space.bilibili.com/208259/video")).toEqual({
      kind: "user",
      mid: 208259,
    });
  });

  it("无法识别时抛错", () => {
    expect(() => parseTarget("随便一段文字")).toThrow(/无法识别/);
    expect(() => parseTarget("")).toThrow(/无法识别/);
  });
});
