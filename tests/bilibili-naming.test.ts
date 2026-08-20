import { describe, expect, it } from "vitest";
import { filenameFilter, renderName } from "../src/bilibili/download/naming.ts";

describe("filenameFilter：非法字符过滤", () => {
  it("路径分隔符替换为空格", () => {
    expect(filenameFilter("a/b\\c\nd")).toBe("a b c d");
  });

  it("窗口非法字符替换为全角等价", () => {
    expect(filenameFilter('a:b*c?"<>|')).toBe("a：b⭐c？'《》丨");
  });

  it("去首尾空格与尾部句点", () => {
    expect(filenameFilter("  标题...  ")).toBe("标题");
  });
});

describe("renderName：命名模板渲染", () => {
  const vars = {
    title: "有趣的视频: 第一集",
    bvid: "BV1xx411c7mD",
    part: "P1",
    pubdate: "2026-01-01",
    up: "UP 主",
  };

  it("默认模板渲染并过滤", () => {
    expect(renderName("{title}/{bvid}_{part}", vars)).toBe("有趣的视频： 第一集/BV1xx411c7mD_P1");
  });

  it("缺失令牌替换为空串", () => {
    expect(renderName("{title}_{missing}", { title: "T" })).toBe("T_");
  });

  it("未知令牌原样保留", () => {
    expect(renderName("{title}{未知}", { title: "T" })).toBe("T{未知}");
  });
});
