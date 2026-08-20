/**
 * `bili_video_info` 工具：按 URL/ID 解析完整信息（含可用音频档位）。
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { BiliClient } from "../api/index.ts";
import { planUnits } from "../download/planner.ts";
import type { ViewResult } from "../types.ts";

interface VideoInfoOutput {
  kind: string;
  title: string;
  author: string;
  desc: string;
  coverUrl: string;
  pubdate: number;
  pages: Array<{ page: number; part: string; duration: number; cid: number }>;
  episodes: Array<{ id: number; title: string; duration: number }>;
  audioFormats: Array<{ id: number; quality: string }>;
  subtitleCount: number;
  /** user 目标才有：投稿总数。 */
  videoCount?: number;
}

/** 从解析结果提取工具输出（不调用网络的部分）。 */
function projectInfo(result: ViewResult): VideoInfoOutput {
  switch (result.kind) {
    case "video": {
      const info = result.info;
      return {
        kind: "video",
        title: info.title,
        author: info.owner.name,
        desc: info.desc,
        coverUrl: info.pic,
        pubdate: info.pubdate,
        pages: info.pages.map((page) => ({
          page: page.page,
          part: page.part,
          duration: page.duration,
          cid: page.cid,
        })),
        episodes: [],
        subtitleCount: info.subtitle.list.length,
        audioFormats: [],
      };
    }
    case "bangumi": {
      const info = result.info;
      return {
        kind: "bangumi",
        title: info.season_title,
        author: info.up_info?.uname ?? "",
        desc: info.evaluate,
        coverUrl: info.cover,
        pubdate: 0,
        pages: [],
        episodes: info.episodes.map((ep) => ({ id: ep.id, title: ep.title, duration: ep.duration ?? 0 })),
        subtitleCount: 0,
        audioFormats: [],
      };
    }
    case "cheese": {
      const info = result.info;
      return {
        kind: "cheese",
        title: info.title,
        author: info.up_info?.uname ?? "",
        desc: "",
        coverUrl: info.cover,
        pubdate: 0,
        pages: [],
        episodes: info.episodes.map((ep) => ({ id: ep.id, title: ep.title, duration: ep.duration ?? 0 })),
        subtitleCount: 0,
        audioFormats: [],
      };
    }
    case "user": {
      const info = result.info;
      return {
        kind: "user",
        title: info.list.vlist[0]?.author ?? "UP 空间",
        author: info.list.vlist[0]?.author ?? "",
        desc: "",
        coverUrl: info.list.vlist[0]?.pic ?? "",
        pubdate: 0,
        pages: [],
        episodes: [],
        subtitleCount: 0,
        audioFormats: [],
        videoCount: info.page.count,
      };
    }
  }
}

/** 渲染为模型面文本。 */
export function renderVideoInfo(output: VideoInfoOutput): string {
  const lines = [output.title, `类型: ${output.kind} | UP: ${output.author}`];
  if (output.desc !== "") lines.push(`简介: ${output.desc.slice(0, 200)}`);
  if (output.pages.length > 0) {
    lines.push(`分P (${output.pages.length}): ${output.pages.map((p) => `P${p.page} ${p.part}`).join(" / ")}`);
  }
  if (output.episodes.length > 0) {
    const shown = output.episodes.slice(0, 20).map((e) => e.title).join(" / ");
    lines.push(`剧集 (${output.episodes.length}): ${shown}${output.episodes.length > 20 ? " …" : ""}`);
  }
  if (output.videoCount !== undefined) lines.push(`投稿数: ${output.videoCount}`);
  if (output.audioFormats.length > 0) {
    lines.push(`可用音频档位: ${output.audioFormats.map((f) => f.quality).join(", ")}`);
  }
  if (output.subtitleCount > 0) lines.push(`CC 字幕: ${output.subtitleCount} 条`);
  lines.push("可用 bili_download 下载音频/封面/字幕/弹幕/元信息到本地。");
  return lines.join("\n");
}

export function biliVideoInfo(client: BiliClient) {
  return defineTool({
    name: "bili_video_info",
    description:
      "Resolve a bilibili URL or ID (bvid / av / ep / ss / uid / full URL) into structured details: title, author, description, pages or episodes, available audio formats, and subtitle availability. Use after bili_search or when given a bilibili link.",
    parameters: {
      target: {
        type: "string",
        required: true,
        description: "bvid / av 号 / ep / ss / uid / 完整 B 站 URL",
      },
      page: { type: "integer", description: "UP 空间投稿页码，从 1 开始，默认 1" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          title: { type: "string" },
          author: { type: "string" },
          desc: { type: "string" },
          coverUrl: { type: "string" },
          pubdate: { type: "integer" },
          pages: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                page: { type: "integer" },
                part: { type: "string" },
                duration: { type: "integer" },
                cid: { type: "integer" },
              },
            },
          },
          episodes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "integer" },
                title: { type: "string" },
                duration: { type: "integer" },
              },
            },
          },
          audioFormats: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "integer" },
                quality: { type: "string" },
              },
            },
          },
          subtitleCount: { type: "integer" },
          videoCount: { type: "integer" },
        },
      },
      render: (_args, value) =>
        [{ type: "text", text: renderVideoInfo(value as unknown as VideoInfoOutput) }] as ContentBlock[],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await client.view(args.target);
      const output = projectInfo(result);
      if (result.kind !== "user") {
        const units = planUnits(result, undefined);
        if (units.length > 0) {
          const unit = units[0]!;
          let ids: { bvid?: string; cid?: number; epId?: number };
          if (unit.kind === "video") {
            if (unit.bvid === undefined || unit.cid === undefined) {
              throw new Error("该视频缺少 bvid/cid");
            }
            ids = { bvid: unit.bvid, cid: unit.cid };
          } else {
            if (unit.epId === undefined) throw new Error("该集缺少 ep_id");
            ids = { epId: unit.epId };
          }
          output.audioFormats = await client.audioFormats(unit.kind, ids);
        }
      }
      return output;
    },
  });
}
