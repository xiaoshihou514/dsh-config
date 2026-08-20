/**
 * `bili_download` 工具：把产物下载到本地 `downloadDir`，入队即返回 taskId + targetPath。
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { BiliClient } from "../api/index.ts";
import { DownloadManager } from "../download/manager.ts";
import { buildTask, planUnits, type PlannerOptions } from "../download/planner.ts";
import type { ArtifactKind } from "../download/task.ts";
import type { AudioQualityName } from "../types.ts";

interface DownloadOutput {
  tasks: Array<{ taskId: string; artifact: string; title: string; targetPath: string }>;
}

/** 渲染为模型面文本。 */
export function renderDownload(output: DownloadOutput): string {
  if (output.tasks.length === 0) return "没有创建任何下载任务。";
  const lines = output.tasks.map(
    (task) => `- ${task.artifact} | ${task.title} → ${task.targetPath}（taskId: ${task.taskId}）`,
  );
  return [`已入队 ${output.tasks.length} 个下载任务：`, ...lines, "用 bili_download_status 查看进度。"].join("\n");
}

export function biliDownload(
  client: BiliClient,
  manager: DownloadManager,
  planner: PlannerOptions,
  defaultArtifacts: ArtifactKind[],
) {
  return defineTool({
    name: "bili_download",
    description:
      "Download artifacts of a bilibili video to local disk: audio (m4a/flac), cover, subtitle (srt), danmaku (xml or json), metadata (json), or nfo. Queues downloads in the background and returns immediately with task ids and target paths; poll with bili_download_status. Omit `artifact` to download the configured default set. For multi-page videos pass `page` to pick one part, otherwise all parts are queued.",
    parameters: {
      target: {
        type: "string",
        required: true,
        description: "bvid / av 号 / ep / ss / 完整 B 站 URL（UP 空间不可下载）",
      },
      artifact: {
        type: "string",
        enum: ["audio", "cover", "subtitle", "danmaku", "json", "nfo"],
        description: "下载产物；省略时下载配置开启的默认集合",
      },
      audioQuality: {
        type: "string",
        enum: ["64K", "132K", "192K", "Dolby", "HiRes"],
        description: "期望音频质量（不可用时按优先级回退），默认取配置",
      },
      format: {
        type: "string",
        enum: ["xml", "json"],
        description: "danmaku 产物格式，默认 xml（json 为解析后的弹幕数组）",
      },
      page: { type: "integer", description: "只下载指定分P（video 目标），默认全部分P" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                taskId: { type: "string" },
                artifact: { type: "string" },
                title: { type: "string" },
                targetPath: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) =>
        [{ type: "text", text: renderDownload(value as unknown as DownloadOutput) }] as ContentBlock[],
    },
    timeoutMs: 15_000,
    // 入队会改动任务管理器，不能与兄弟调用并发
    isConcurrencySafe: () => false,
    async execute(args) {
      const artifacts =
        args.artifact !== undefined
          ? ([args.artifact] as ArtifactKind[])
          : defaultArtifacts.length > 0
            ? defaultArtifacts
            : (["json"] as ArtifactKind[]);
      const quality = (args.audioQuality ?? planner.audioQuality) as AudioQualityName;
      const result = await client.view(args.target);
      const units = planUnits(result, args.page);
      const tasks = units.flatMap((unit) =>
        artifacts.map((artifact) => buildTask(client, planner, unit, artifact, args.format ?? "xml")),
      );
      for (const task of tasks) manager.enqueue(task);
      const output: DownloadOutput = {
        tasks: tasks.map((task) => ({
          taskId: task.id,
          artifact: task.artifact,
          title: task.title,
          targetPath: task.targetPath,
        })),
      };
      return output;
    },
  });
}
