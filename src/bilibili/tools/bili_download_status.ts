/**
 * `bili_download_status` 工具：轮询下载任务进度。
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DownloadManager } from "../download/manager.ts";

interface StatusItem {
  taskId: string;
  artifact: string;
  title: string;
  state: string;
  bytesDone: number;
  bytesTotal?: number;
  percent?: number;
  targetPath: string;
  error?: string;
}

/** projectStatus 的输入（任务与历史记录的公共形状）。 */
interface StatusSource {
  id: string;
  artifact: string;
  title: string;
  state: string;
  bytesDone: number;
  bytesTotal: number | undefined;
  targetPath: string;
  error: string | undefined;
}

/** 任务/历史记录 → 统一状态项。 */
function projectStatus(task: StatusSource): StatusItem {
  const item: StatusItem = {
    taskId: task.id,
    artifact: task.artifact,
    title: task.title,
    state: task.state,
    bytesDone: task.bytesDone,
    targetPath: task.targetPath,
  };
  if (task.bytesTotal !== undefined) item.bytesTotal = task.bytesTotal;
  if (task.bytesTotal !== undefined && task.bytesTotal > 0) {
    item.percent = Math.round((task.bytesDone / task.bytesTotal) * 100);
  }
  if (task.error !== undefined) item.error = task.error;
  return item;
}

const STATE_LABEL: Record<string, string> = {
  queued: "排队中",
  downloading: "下载中",
  done: "完成",
  error: "失败",
  canceled: "已取消",
};

/** 渲染为模型面文本。 */
export function renderStatus(items: StatusItem[]): string {
  if (items.length === 0) return "当前没有下载任务。";
  const lines = items.map((item) => {
    const progress =
      item.percent !== undefined
        ? `${item.percent}%（${item.bytesDone}/${item.bytesTotal} 字节）`
        : item.bytesDone > 0
          ? `${item.bytesDone} 字节`
          : "";
    const error = item.error !== undefined ? ` | 错误: ${item.error}` : "";
    return `- [${item.taskId}] ${STATE_LABEL[item.state] ?? item.state} ${item.artifact} | ${item.title} ${progress} → ${item.targetPath}${error}`;
  });
  return ["下载任务：", ...lines].join("\n");
}

export function biliDownloadStatus(manager: DownloadManager) {
  return defineTool({
    name: "bili_download_status",
    description:
      "Poll progress of bilibili download tasks. Returns state (queued/downloading/done/error/canceled), bytes and percent for each task, including finished tasks from history. Omit taskId to list all.",
    parameters: {
      taskId: { type: "string", description: "任务 id（bili_download 返回）；省略则列全部" },
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
                state: { type: "string" },
                bytesDone: { type: "integer" },
                bytesTotal: { type: "integer" },
                percent: { type: "integer" },
                targetPath: { type: "string" },
                error: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) =>
        [{ type: "text", text: renderStatus((value as { tasks: StatusItem[] }).tasks) }] as ContentBlock[],
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const seen = new Set<string>();
      const items: StatusItem[] = [];
      for (const task of manager.list()) {
        seen.add(task.id);
        if (args.taskId !== undefined && task.id !== args.taskId) continue;
        items.push(
          projectStatus({
            id: task.id,
            artifact: task.artifact,
            title: task.title,
            state: task.state,
            bytesDone: task.bytesDone,
            bytesTotal: task.bytesTotal,
            targetPath: task.targetPath,
            error: task.error,
          }),
        );
      }
      if (args.taskId === undefined) {
        for (const record of manager.history()) {
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          items.push(
            projectStatus({
              id: record.id,
              artifact: record.artifact,
              title: record.title,
              state: record.state,
              bytesDone: record.bytesDone ?? 0,
              bytesTotal: record.bytesTotal,
              targetPath: record.targetPath,
              error: record.error,
            }),
          );
        }
      }
      return { tasks: items };
    },
  });
}
