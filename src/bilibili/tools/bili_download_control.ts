/**
 * `bili_download_control` 工具：取消/删除下载任务。
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DownloadManager } from "../download/manager.ts";

export function biliDownloadControl(manager: DownloadManager) {
  return defineTool({
    name: "bili_download_control",
    description:
      "Cancel or delete a bilibili download task. cancel stops the download (the task stays listed as canceled); delete also removes it from the registry.",
    parameters: {
      taskId: { type: "string", required: true, description: "任务 id（bili_download 返回）" },
      action: { type: "string", enum: ["cancel", "delete"], required: true, description: "cancel 或 delete" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          action: { type: "string" },
          ok: { type: "boolean" },
        },
      },
      render: (_args, value) => {
        const v = value as { taskId: string; action: string; ok: boolean };
        return [
          {
            type: "text",
            text: v.ok ? `任务 ${v.taskId} 已${v.action === "delete" ? "删除" : "取消"}。` : `任务 ${v.taskId} 不存在。`,
          },
        ] as ContentBlock[];
      },
    },
    timeoutMs: 5_000,
    // 改动任务管理器，不能与兄弟调用并发
    isConcurrencySafe: () => false,
    async execute(args) {
      const ok = args.action === "delete" ? manager.remove(args.taskId) : manager.cancel(args.taskId);
      return { taskId: args.taskId, action: args.action, ok };
    },
  });
}
