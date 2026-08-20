import { describe, expect, it } from "vitest";
import { cleanCoverUrl, coverExtension, srtTimestamp, subtitleToSrt } from "../src/bilibili/download/formats.ts";

describe("srt 时间戳", () => {
  it("秒数转 HH:MM:SS,mmm", () => {
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    expect(srtTimestamp(65.5)).toBe("00:01:05,500");
    expect(srtTimestamp(3661.999)).toBe("01:01:01,999");
  });
});

describe("subtitleToSrt", () => {
  it("body → SRT 文本", () => {
    const srt = subtitleToSrt([
      { from: 0, to: 1.5, content: "你好" },
      { from: 2, to: 3, content: "世界" },
    ]);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\n你好\n\n2\n00:00:02,000 --> 00:00:03,000\n世界\n",
    );
  });
});

describe("封面 URL 清理", () => {
  it("去掉 @ 缩略图参数", () => {
    expect(cleanCoverUrl("https://i0.hdslb.com/bfs/archive/xxx.jpg@672w_378h_1c!web-search-common-cover")).toBe(
      "https://i0.hdslb.com/bfs/archive/xxx.jpg",
    );
  });

  it("去掉查询串", () => {
    expect(cleanCoverUrl("https://i0.hdslb.com/bfs/archive/xxx.png?x=1&y=2")).toBe(
      "https://i0.hdslb.com/bfs/archive/xxx.png",
    );
  });

  it("无参数原样返回", () => {
    expect(cleanCoverUrl("https://i0.hdslb.com/bfs/archive/xxx.jpg")).toBe(
      "https://i0.hdslb.com/bfs/archive/xxx.jpg",
    );
  });
});

describe("封面扩展名", () => {
  it("从 URL 提取，缺省 jpg", () => {
    expect(coverExtension("https://x/a.webp")).toBe("webp");
    expect(coverExtension("https://x/a.jpg@672w_378h")).toBe("jpg");
    expect(coverExtension("https://x/a")).toBe("jpg");
    expect(coverExtension("")).toBe("jpg");
  });
});
