import { describe, expect, it } from "vitest";
import { friendlyBiliError } from "../src/bilibili/errors.ts";
import { BiliError } from "../src/bilibili/http.ts";

describe("friendlyBiliError：错误码映射", () => {
  it("-352 风控提示放慢频率", () => {
    expect(friendlyBiliError(new BiliError(-352, "请求过于频繁"))).toContain("风控");
  });

  it("-101 未登录提示配置 sessdata", () => {
    expect(friendlyBiliError(new BiliError(-101, "账号未登录"))).toContain("sessdata");
  });

  it("-404 提示目标不存在", () => {
    expect(friendlyBiliError(new BiliError(-404, "啥都木有"))).toContain("不存在");
  });

  it("未映射的 code 透出原始 message", () => {
    expect(friendlyBiliError(new BiliError(-9999, "自定义错误"))).toBe(
      "bilibili -9999: 自定义错误",
    );
  });

  it("非 BiliError 透出 Error.message", () => {
    expect(friendlyBiliError(new Error("网络错误"))).toBe("网络错误");
    expect(friendlyBiliError("裸字符串")).toBe("裸字符串");
  });
});
