/**
 * dsh-config-bilibili 配置（schemastery，cordis.yml 可配；无 UI）。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import type { AudioQualityName } from "./types.ts";

/** 默认下载目录。 */
export const DEFAULT_DOWNLOAD_DIR = join(homedir(), "Downloads", "bilibili");

/** 默认命名模板：`{title}/{bvid}_{part}`，令牌见 {@link renderName}。 */
export const DEFAULT_NAMING_TEMPLATE = "{title}/{bvid}_{part}";

export interface Config {
  /** 登录态；留空则匿名（音频档位受限、风控概率更高）。 */
  sessdata?: string;
  /** 下载产物落盘目录。 */
  downloadDir: string;
  /** 期望音频质量：64K | 132K | 192K | Dolby | HiRes。 */
  audioQuality: AudioQualityName;
  /** 下载哪些产物（`bili_download` 省略 artifact 时按此集合下载，默认全开）。 */
  downloadArtifacts: {
    audio: boolean;
    cover: boolean;
    subtitle: boolean;
    danmaku: boolean;
    json: boolean;
    nfo: boolean;
  };
  /** 目录/文件命名模板，令牌：{title} {bvid} {part} {pubdate} {up}。 */
  namingTemplate: string;
  /** 并发下载任务数。 */
  concurrency: number;
  /** 相邻请求最小间隔（ms），风控友好。 */
  requestIntervalMs: number;
  /** 系统 ffmpeg 路径（预留；当前无调用点）。 */
  ffmpegPath: string;
}

export const Config = z.object({
  sessdata: z.string().default(""),
  downloadDir: z.string().default(DEFAULT_DOWNLOAD_DIR),
  audioQuality: z
    .union(["64K", "132K", "192K", "Dolby", "HiRes"] as const)
    .default("192K"),
  downloadArtifacts: z
    .object({
      audio: z.boolean().default(true),
      cover: z.boolean().default(true),
      subtitle: z.boolean().default(true),
      danmaku: z.boolean().default(true),
      json: z.boolean().default(true),
      nfo: z.boolean().default(true),
    })
    .default({ audio: true, cover: true, subtitle: true, danmaku: true, json: true, nfo: true }),
  namingTemplate: z.string().default(DEFAULT_NAMING_TEMPLATE),
  concurrency: z.number().default(2),
  requestIntervalMs: z.number().default(200),
  ffmpegPath: z.string().default("ffmpeg"),
});
