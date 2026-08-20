/**
 * `bili_search` 工具：关键词搜索 B 站视频/番剧/课程/UP。
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { BiliClient } from "../api/index.ts";
import type { SearchResults } from "../types.ts";

/** 渲染搜索结果（模型面纯文本）。 */
export function renderSearchResult(result: SearchResults): string {
  if (result.results.length === 0) return "没有找到结果。";
  const lines = result.results.map((item, index) => {
    const meta: string[] = [item.kind];
    if (item.author !== undefined) meta.push(item.author);
    if (item.duration !== undefined) meta.push(item.duration);
    if (item.play !== undefined) meta.push(`播放 ${item.play}`);
    if (item.danmaku !== undefined) meta.push(`弹幕 ${item.danmaku}`);
    const id =
      item.bvid ??
      (item.epId !== undefined ? `ep${item.epId}` : undefined) ??
      (item.seasonId !== undefined ? `ss${item.seasonId}` : undefined) ??
      (item.mid !== undefined ? `uid${item.mid}` : undefined) ??
      "";
    return `${index + 1}. ${item.title} — ${meta.join(" / ")}${id !== "" ? `（${id}）` : ""}`;
  });
  return [
    `共 ${result.total} 条结果，第 ${result.page} 页：`,
    ...lines,
    "可用 bili_video_info 查看某个结果的详细信息。",
  ].join("\n");
}

export function biliSearch(client: BiliClient) {
  return defineTool({
    name: "bili_search",
    description:
      "Search bilibili by keyword for videos, anime (bangumi), courses (cheese), or users. Returns structured results with bvid/ep/ss/uid identifiers for follow-up bili_video_info or bili_download calls.",
    parameters: {
      query: { type: "string", required: true, description: "搜索关键词" },
      type: {
        type: "string",
        enum: ["video", "bangumi", "cheese", "user", "live_user"],
        description: "搜索类型，默认 video",
      },
      page: { type: "integer", description: "页码，从 1 开始，默认 1" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string" },
          page: { type: "integer" },
          total: { type: "integer" },
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string" },
                title: { type: "string" },
                author: { type: "string" },
                cover: { type: "string" },
                duration: { type: "string" },
                play: { type: "integer" },
                danmaku: { type: "integer" },
                bvid: { type: "string" },
                epId: { type: "integer" },
                seasonId: { type: "integer" },
                mid: { type: "integer" },
                description: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderSearchResult(value as unknown as SearchResults) }] as ContentBlock[],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await client.search(args.query.trim(), args.type ?? "video", args.page ?? 1);
      return result as unknown as Record<string, unknown>;
    },
  });
}
