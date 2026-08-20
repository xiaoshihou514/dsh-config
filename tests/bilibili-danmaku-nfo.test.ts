import { describe, expect, it } from "vitest";
import { danmakuXmlToJson, unescapeXml } from "../src/bilibili/download/formats.ts";
import { buildNfo, escapeXml } from "../src/bilibili/download/nfo.ts";

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<i>
  <chatserver>chat.bilibili.com</chatserver>
  <chatid>12345</chatid>
  <maxlimit>3000</maxlimit>
  <d p="0.5,1,25,16777215,1700000000,0,abc,1">第一弹幕</d>
  <d p="3.75,4,18,65280,1700000001,0,def,2">底部&amp;弹幕&lt;特殊&gt;</d>
</i>`;

describe("danmakuXmlToJson", () => {
  it("解析弹幕条目的时间/模式/字号/颜色/文本", () => {
    const items = danmakuXmlToJson(SAMPLE_XML);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ time: 0.5, mode: 1, fontsize: 25, color: 16777215, text: "第一弹幕" });
    expect(items[1]).toEqual({ time: 3.75, mode: 4, fontsize: 18, color: 65280, text: "底部&弹幕<特殊>" });
  });

  it("空 XML 返回空数组", () => {
    expect(danmakuXmlToJson("<i></i>")).toEqual([]);
  });
});

describe("unescapeXml", () => {
  it("反转义常用实体", () => {
    expect(unescapeXml("&lt;a&gt; &amp; &quot;q&quot; &#39;s&#39; &#65; &#x42;")).toBe("<a> & \"q\" 's' A B");
  });
});

describe("buildNfo", () => {
  it("完整字段输出 movie NFO", () => {
    const nfo = buildNfo({
      title: "测试视频 & 番剧",
      uniqueId: "BV1xx411c7mD",
      plot: "简介 <内容>",
      poster: "BV1xx411c7mD_P1.jpg",
      pubdate: "2026-01-01",
    });
    expect(nfo).toContain('<title>测试视频 &amp; 番剧</title>');
    expect(nfo).toContain('<uniqueid type="bilibili">BV1xx411c7mD</uniqueid>');
    expect(nfo).toContain('<plot>简介 &lt;内容&gt;</plot>');
    expect(nfo).toContain("<poster>BV1xx411c7mD_P1.jpg</poster>");
    expect(nfo).toContain("<premiered>2026-01-01</premiered>");
    expect(nfo.endsWith("</movie>\n")).toBe(true);
  });

  it("空字段不输出对应标签", () => {
    const nfo = buildNfo({ title: "T" });
    expect(nfo).not.toContain("<uniqueid");
    expect(nfo).not.toContain("<plot>");
    expect(nfo).not.toContain("<art>");
  });
});

describe("escapeXml", () => {
  it("转义 XML 特殊字符", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });
});
