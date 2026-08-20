#!/usr/bin/env node
/**
 * B 站真实 API 冒烟（设计文档 §8）：搜索 → 解析 → 下载核心产物（弹幕/json/nfo，
 * 封面尽力而为）到临时目录，校验落盘后退出。
 *
 * 用法（先 `pnpm build`）：
 *   DSH_BILIBILI_E2E=1 pnpm smoke:bilibili
 *   DSH_BILIBILI_TARGET=BV1xx411c7mD DSH_BILIBILI_E2E=1 pnpm smoke:bilibili
 *   DSH_BILIBILI_SESSDATA=xxx DSH_BILIBILI_E2E=1 pnpm smoke:bilibili   # 有登录态再验音频
 *
 * 退出码：核心产物（弹幕 + json + nfo）全部落盘为 0，否则 1。
 * 封面/字幕/音频失败不计入失败（CDN 可能被网络环境拦截；字幕可能不存在）。
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BiliClient, DownloadManager, buildTask, planUnits } from "../lib/bilibili.js";

if (process.env.DSH_BILIBILI_E2E !== "1") {
  console.error("跳过：设置 DSH_BILIBILI_E2E=1 才运行真实 API 冒烟。");
  process.exit(0);
}

const target = process.env.DSH_BILIBILI_TARGET ?? "av170001";
const dir = await mkdtemp(join(tmpdir(), "bili-smoke-"));

const client = new BiliClient({
  ...(process.env.DSH_BILIBILI_SESSDATA !== undefined
    ? { sessdata: process.env.DSH_BILIBILI_SESSDATA }
    : {}),
  requestIntervalMs: 200,
});
const manager = new DownloadManager({ concurrency: 2 });
const planner = { downloadDir: dir, namingTemplate: "{bvid}_{part}", audioQuality: "192K" };

console.log(`目标: ${target}`);

// 1) 关键词搜索（验证 WBI 签名路径）
const search = await client.search("猫meme", "video", 1);
if (search.results.length === 0) {
  console.error("搜索无结果");
  process.exit(1);
}
console.log(`搜索: ${search.total} 条，首个「${search.results[0]?.title}」`);

// 2) URL/ID 解析
const result = await client.view(target);
console.log(`解析: ${result.kind} | ${result.info.title}`);

// 3) 下载核心产物 + 尽力而为的封面
const unit = planUnits(result, 1)[0];
if (unit === undefined) {
  console.error("没有可下载的单元");
  process.exit(1);
}
const artifacts = ["danmaku", "json", "nfo", "cover"];
for (const artifact of artifacts) manager.enqueue(buildTask(client, planner, unit, artifact));

await Promise.all(manager.list().map((task) => task.settled));
for (const task of manager.list()) {
  console.log(`[${task.state}] ${task.artifact} → ${task.targetPath}${task.error !== undefined ? `（${task.error}）` : ""}`);
}

// 4) 校验核心产物确实落盘
const core = ["danmaku", "json", "nfo"];
const missing = [];
for (const task of manager.list()) {
  if (task.state !== "done") {
    if (core.includes(task.artifact)) missing.push(`${task.artifact}(${task.state})`);
    continue;
  }
  try {
    const stat = await readFile(task.targetPath);
    console.log(`校验: ${task.artifact} ${stat.length} 字节`);
  } catch {
    if (core.includes(task.artifact)) missing.push(`${task.artifact}(无文件)`);
  }
}

const files = await readdir(dir, { recursive: true });
console.log(`产物: ${files.join(", ")}`);
await rm(dir, { recursive: true, force: true });

if (missing.length > 0) {
  console.error(`失败: 核心产物缺失 ${missing.join(", ")}`);
  process.exit(1);
}
console.log("冒烟通过 ✓");
