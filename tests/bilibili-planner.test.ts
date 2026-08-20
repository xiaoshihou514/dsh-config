import { describe, expect, it } from "vitest";
import { planUnits, pickSubtitle } from "../src/bilibili/download/planner.ts";
import type { ViewResult } from "../src/bilibili/types.ts";

const videoResult = (pages: Array<{ page: number; cid: number; part: string; duration: number }>): ViewResult => ({
  kind: "video",
  info: {
    bvid: "BV1xx411c7mD",
    aid: 1,
    title: "测试视频: 合集",
    desc: "",
    pic: "https://i0.hdslb.com/bfs/archive/x.jpg",
    pubdate: 1700000000,
    duration: 100,
    owner: { mid: 1, name: "UP主", face: "" },
    stat: { view: 1, danmaku: 1, reply: 1, favorite: 1, coin: 1, share: 1, like: 1 },
    pages,
    subtitle: { list: [] },
  },
});

const bangumiResult = (ep: { id: number; ep_id: number; cid: number; title: string } | null): ViewResult => ({
  kind: "bangumi",
  ep,
  info: {
    season_id: 1,
    season_title: "测试番剧",
    cover: "https://i0.hdslb.com/bfs/archive/b.jpg",
    evaluate: "简介",
    episodes: [
      { id: 11, ep_id: 11, cid: 111, aid: 1, title: "第一集", long_title: "启程" },
      { id: 12, ep_id: 12, cid: 122, aid: 1, title: "第二集" },
    ],
  },
});

describe("planUnits", () => {
  it("video：全部分P → 每 P 一个单元", () => {
    const units = planUnits(
      videoResult([
        { page: 1, cid: 100, part: "P1", duration: 10 },
        { page: 2, cid: 200, part: "P2", duration: 20 },
      ]),
    );
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ kind: "video", cid: 100, bvid: "BV1xx411c7mD", vars: { part: "P1" } });
    expect(units[1]).toMatchObject({ cid: 200, vars: { part: "P2" } });
  });

  it("video：指定 page 只给该 P", () => {
    const units = planUnits(
      videoResult([
        { page: 1, cid: 100, part: "P1", duration: 10 },
        { page: 2, cid: 200, part: "P2", duration: 20 },
      ]),
      2,
    );
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ cid: 200 });
  });

  it("video：page 不存在抛错", () => {
    expect(() => planUnits(videoResult([{ page: 1, cid: 100, part: "P1", duration: 10 }]), 9)).toThrow(/page=9/);
  });

  it("bangumi：ep 目标只给单集", () => {
    const units = planUnits(bangumiResult({ id: 11, ep_id: 11, cid: 111, title: "第一集" }));
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: "bangumi", epId: 11, cid: 111, bvid: "EP11" });
  });

  it("bangumi：season 目标给全部集", () => {
    const units = planUnits(bangumiResult(null));
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.epId)).toEqual([11, 12]);
  });

  it("user 目标不可下载", () => {
    const result: ViewResult = {
      kind: "user",
      info: { list: { vlist: [] }, page: { pn: 1, ps: 30, count: 0 } },
    };
    expect(() => planUnits(result)).toThrow(/UP 空间/);
  });
});

describe("pickSubtitle", () => {
  const subs = [
    { id: 1, lan: "en-US", lan_doc: "英语", subtitle_url: "https://x/en" },
    { id: 2, lan: "zh-CN", lan_doc: "中文", subtitle_url: "https://x/zh" },
    { id: 3, lan: "ai-zh", lan_doc: "AI 中文", subtitle_url: "https://x/ai" },
  ];

  it("优先 zh-CN", () => {
    expect(pickSubtitle(subs)?.lan).toBe("zh-CN");
  });

  it("无 zh-CN 时优先 ai-zh", () => {
    const noZh = subs.filter((s) => s.lan !== "zh-CN");
    expect(pickSubtitle(noZh)?.lan).toBe("ai-zh");
  });

  it("空列表返回 undefined", () => {
    expect(pickSubtitle([])).toBeUndefined();
  });
});
