/**
 * B 站内容理解与下载工具（bilibili-video-downloader 的 TS 内联版）。
 *
 * 设计文档：docs/agent/bilibili-tool.md。
 *
 * - 纯 agent 工具，不暴露任何 UI；不做视频下载。
 * - 工具面（5 个）：bili_search / bili_video_info / bili_download /
 *   bili_download_status / bili_download_control。
 * - bili_download 把产物（音频/封面/字幕/弹幕/json/nfo）下载到本地 downloadDir，
 *   入队即返回 taskId + targetPath；字幕/弹幕内容由 agent 用自身 fs 工具读文件
 *   理解，音频落盘后跑本地 ASR。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { BiliClient } from "./api/index.ts";
import { DownloadManager } from "./download/manager.ts";
import { buildTask, planUnits } from "./download/planner.ts";
import type { ArtifactKind } from "./download/task.ts";
import { Config } from "./settings.ts";
import { biliDownload } from "./tools/bili_download.ts";
import { biliDownloadControl } from "./tools/bili_download_control.ts";
import { biliDownloadStatus } from "./tools/bili_download_status.ts";
import { biliSearch } from "./tools/bili_search.ts";
import { biliVideoInfo } from "./tools/bili_video_info.ts";

export const name = "dsh-config-bilibili";
export const inject = ["tools"];

export { Config };
export type { Config as BilibiliConfig } from "./settings.ts";

// 库接口（供 scripts/bilibili-smoke.mjs 等外部脚本使用）
export { BiliClient } from "./api/index.ts";
export { DownloadManager } from "./download/manager.ts";
export { buildTask, planUnits } from "./download/planner.ts";

/** 下载历史文件路径（对齐 usage-api 的数据目录约定）。 */
function historyPath(): string {
  return join(
    process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
    "dsh-config",
    "bilibili-tasks.json",
  );
}

/** 配置里开启的产物集合（`bili_download` 省略 artifact 时使用）。 */
function enabledArtifacts(config: Config): ArtifactKind[] {
  const map: Record<keyof Config["downloadArtifacts"], ArtifactKind> = {
    audio: "audio",
    cover: "cover",
    subtitle: "subtitle",
    danmaku: "danmaku",
    json: "json",
    nfo: "nfo",
  };
  return (Object.keys(map) as Array<keyof Config["downloadArtifacts"]>)
    .filter((key) => config.downloadArtifacts[key])
    .map((key) => map[key]);
}

export function apply(ctx: Context, config: Config): void {
  const client = new BiliClient({
    ...(config.sessdata !== "" ? { sessdata: config.sessdata } : {}),
    requestIntervalMs: config.requestIntervalMs,
  });
  const manager = new DownloadManager({
    concurrency: config.concurrency,
    historyPath: historyPath(),
  });
  const planner = {
    downloadDir: config.downloadDir,
    namingTemplate: config.namingTemplate,
    audioQuality: config.audioQuality,
  };
  for (const tool of [
    biliSearch(client),
    biliVideoInfo(client),
    biliDownload(client, manager, planner, enabledArtifacts(config)),
    biliDownloadStatus(manager),
    biliDownloadControl(manager),
  ]) {
    ctx.tools.register(tool);
  }
}
