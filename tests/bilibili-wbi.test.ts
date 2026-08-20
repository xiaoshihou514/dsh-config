import { describe, expect, it } from "vitest";
import { getMixinKey, urlEncode, wbiSign } from "../src/bilibili/wbi.ts";

/** bilibili-API-collect 文档示例 keys（公开固定值）。 */
const DOC_KEYS = {
  imgKey: "7cd084941338484aae1ad9425b84077c",
  subKey: "4932caff0ff746eab6f01bf08b70ac45",
};

describe("wbi 签名", () => {
  it("mixin key 与公开文档值一致", () => {
    expect(getMixinKey(DOC_KEYS.imgKey, DOC_KEYS.subKey)).toBe("ea1db124af3c7062474693fa704f4ff8");
  });

  it("urlEncode：非 ASCII 按 UTF-8 字节 %XX 大写编码", () => {
    expect(urlEncode("你好")).toBe("%E4%BD%A0%E5%A5%BD");
  });

  it("urlEncode：字母数字与 -_.~ 原样保留", () => {
    expect(urlEncode("abc-_.~123")).toBe("abc-_.~123");
  });

  it("urlEncode：空格编码为 %20，!'()* 丢弃", () => {
    expect(urlEncode("hello world")).toBe("hello%20world");
    expect(urlEncode("a!b'c(d)e")).toBe("abcde");
  });

  it("签名向量回归锁定（固定 keys 与时间戳）", () => {
    const signed = wbiSign(
      { keyword: "AI 视频", page: "1", search_type: "video" },
      DOC_KEYS,
      1702204723,
    );
    expect(signed).toEqual({
      keyword: "AI 视频",
      page: "1",
      search_type: "video",
      wts: "1702204723",
      w_rid: "79ee8b1eaf96231090ac4520fc303ee2",
    });
  });

  it("不同时间戳产生不同 w_rid", () => {
    const a = wbiSign({ keyword: "x" }, DOC_KEYS, 1000);
    const b = wbiSign({ keyword: "x" }, DOC_KEYS, 2000);
    expect(a.wts).toBe("1000");
    expect(b.wts).toBe("2000");
    expect(a.w_rid).not.toBe(b.w_rid);
  });
});
