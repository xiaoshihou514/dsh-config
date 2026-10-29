/**
 * dsh 会话 → opencode 会话的持久映射。
 *
 * 映射原本只存在内存里，dsh 一重启就丢，于是每个会话都会重新建一个
 * opencode 会话（历史重新注入、opencode 侧的工具上下文丢失）。这里把它
 * 落到 `~/.cache/dsh-opencode/sessions.json`（0600），dsh 重启后仍能接上
 * 原来的 opencode 会话。
 *
 * 文件损坏、只读 HOME 等情况一律降级为空映射：最坏也只是重建一次会话，
 * 不影响对话。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type OpencodeSessionMap = Map<string, string>;

/** 读取映射；文件不存在或内容不合法时返回空映射。 */
export function readSessionMap(file: string): OpencodeSessionMap {
  const map: OpencodeSessionMap = new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return map;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return map;
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "" && typeof value === "string" && value !== "") map.set(key, value);
  }
  return map;
}

/** 原子写回映射（临时文件 + rename），失败静默忽略。 */
export function writeSessionMap(file: string, map: OpencodeSessionMap): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(map), null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch {
    // 只读 HOME 等：映射仍在本进程内有效。
  }
}
