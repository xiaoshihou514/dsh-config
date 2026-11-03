/**
 * 限流换出口之后的交接文本。
 *
 * 新会话只看到摘要，不继承旧会话的消息序号，避免上游把换 IP 前后认成同一条会话。
 */

const DIGEST_MAX = 12_000;
const SUMMARY_MAX = 8_000;

/** 去掉会话号、消息号，避免摘要把旧序号带进新会话。 */
export function scrubIds(text: string): string {
  return text
    .replace(/\bses_[A-Za-z0-9_-]+\b/g, "")
    .replace(/\bmsg_[A-Za-z0-9_-]+\b/g, "");
}

/** 过长记录只留头尾，给摘要模型或新会话当兜底背景。 */
export function localDigest(text: string): string {
  const trimmed = scrubIds(text).trim();
  if (trimmed.length <= DIGEST_MAX) return trimmed;
  return `${trimmed.slice(0, 8_000)}\n\n…\n\n${trimmed.slice(-3_500)}`;
}

/** 把摘要收成新会话的第一条用户消息，并写明当前请求。 */
export function handoffPrompt(brief: string, userText: string): string {
  const parts = [
    "这是一次全新的会话。不要提及旧会话编号或消息序号。根据交接摘要继续未完成的工作，已经完成的不要重复。",
  ];
  const body = brief.trim();
  if (body !== "") parts.push(body.length <= SUMMARY_MAX ? body : `${body.slice(0, SUMMARY_MAX)}\n…`);
  parts.push(`[当前用户消息]\n${userText}`);
  return parts.join("\n\n");
}

/** 从 opencode 的消息列表响应里抽出可交接的纯文本。 */
export function formatOpencodeTranscript(body: unknown): string {
  return messageList(body)
    .map((message) => formatMessage(message))
    .filter((line) => line !== "")
    .join("\n\n");
}

function messageList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const record = asRecord(body);
  if (record === undefined) return [];
  if (Array.isArray(record["data"])) return record["data"];
  const data = asRecord(record["data"]);
  if (data !== undefined) {
    if (Array.isArray(data["items"])) return data["items"];
    if (Array.isArray(data["messages"])) return data["messages"];
  }
  if (Array.isArray(record["items"])) return record["items"];
  if (Array.isArray(record["messages"])) return record["messages"];
  return [];
}

function formatMessage(message: unknown): string {
  const record = asRecord(message);
  if (record === undefined) return "";
  const body = clip(collectText(record["content"] ?? record["parts"]));
  if (body.trim() === "") return "";
  return `${roleLabel(record)}：${body.trim()}`;
}

function roleLabel(record: Record<string, unknown>): string {
  const role = String(record["role"] ?? record["type"] ?? "");
  if (role === "user" || role === "human") return "用户";
  if (role === "assistant") return "助手";
  if (role === "synthetic" || role === "system") return "系统";
  if (role === "tool") return "工具";
  return role === "" ? "消息" : role;
}

function collectText(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => collectText(item, depth + 1))
      .filter((item) => item.trim() !== "")
      .join("\n");
  }
  const record = asRecord(value);
  if (record === undefined) return "";
  const type = record["type"];
  if (type === "tool" || type === "tool-call" || type === "tool-result") {
    const name = typeof record["name"] === "string" ? record["name"] : "tool";
    const detail =
      firstText(record["output"]) ??
      firstText(record["text"]) ??
      firstText(record["content"]) ??
      compact(record["input"] ?? record["state"]);
    return `[工具 ${name}] ${detail}`.trim();
  }
  if (
    typeof record["text"] === "string" &&
    (type === undefined || type === "text" || type === "reasoning")
  ) {
    return record["text"];
  }
  const nested = record["content"] ?? record["parts"] ?? record["output"];
  if (nested !== undefined && nested !== value) return collectText(nested, depth + 1);
  return "";
}

function firstText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  return undefined;
}

function compact(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return clip(value, 500);
  try {
    return clip(JSON.stringify(value), 500);
  } catch {
    return "";
  }
}

function clip(text: string, max = 1_500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
