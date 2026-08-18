/** Durable DeepSeek-official token accounting and its same-origin read API. */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

export const name = "dsh-config-usage-api";
export const inject = ["sessions", "webServer"];

const ROUTE = "/dsh-config/usage";
const HEADER = "x-dsh-config";
const HEADER_VALUE = "usage-calendar";
const PROVIDER = "deepseek-official";

type Model = "deepseek-v4-flash" | "deepseek-v4-pro";

interface UsageRecord {
  id: string;
  at: number;
  project: string;
  model: Model;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface UsageFile {
  version: 1;
  records: UsageRecord[];
}

interface Header {
  provider: string;
  model: string;
}

function dataPath(): string {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "dsh-config", "usage.json");
}

function modelFor(header: Header | undefined): Model | undefined {
  if (header?.provider !== PROVIDER) return undefined;
  return header.model === "deepseek-v4-pro" || header.model === "deepseek-v4-flash"
    ? header.model
    : undefined;
}

function projectName(cwd: string | undefined): string {
  return cwd === undefined ? "未指定项目" : basename(cwd) || cwd;
}

async function load(path: string): Promise<UsageFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = parsed as Partial<UsageFile>;
      if (candidate.version === 1 && Array.isArray(candidate.records)) {
        return { version: 1, records: candidate.records.filter(isRecord) };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: 1, records: [] };
}

function isRecord(value: unknown): value is UsageRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<UsageRecord>;
  return typeof record.id === "string" && typeof record.at === "number" && typeof record.project === "string"
    && (record.model === "deepseek-v4-flash" || record.model === "deepseek-v4-pro")
    && [record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens]
      .every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0);
}

async function save(path: string, value: UsageFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/** Last header per session, used to attribute its following usage event. */
export function apply(ctx: Context): void {
  const headers = new WeakMap<object, Header>();
  const pending = new Map<string, UsageRecord>();
  const path = dataPath();
  // 内存态即权威（写队列只落后毫秒级）：读取不等待写队列，避免被磁盘保存卡住。
  let file = load(path).then((loaded) => {
    refreshCache(loaded);
    return loaded;
  });
  let writes = Promise.resolve();
  // 惰性序列化缓存：数据变化时置空，仅在被请求时才重新 stringify；
  // etag 为「条数:末条 id」，空闲轮询直接 304，零 payload。
  let serialized: string | null = null;
  let etag = "";

  const refreshCache = (next: UsageFile): void => {
    const last = next.records[next.records.length - 1];
    etag = `${next.records.length}:${last?.id ?? ""}`;
    serialized = null;
  };

  const account = (session: { id: string; header: { cwd?: string } }, event: SessionEvent): void => {
    if (event.type === "request/header") {
      headers.set(session, event.data.header.config);
      return;
    }
    let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
    let turn: number | undefined;
    let step: number | undefined;
    if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
      usage = event.data.chunk.usage;
      turn = event.data.turn;
      step = event.data.step;
    } else if (event.type === "assistant/message" && event.data.usage !== undefined) {
      usage = event.data.usage;
      turn = event.data.turn;
      step = event.data.step;
    }
    if (usage === undefined || turn === undefined || step === undefined) return;
    const model = modelFor(headers.get(session));
    if (model === undefined) return;
    const id = `${session.id}:${turn}:${step}`;
    pending.set(id, {
      id,
      at: event.time,
      project: projectName(session.header.cwd),
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0
    });
    writes = writes.then(async () => {
      const next = await file;
      const record = pending.get(id);
      if (record === undefined) return;
      const index = next.records.findIndex((entry) => entry.id === id);
      if (index >= 0) next.records[index] = record;
      else next.records.push(record);
      pending.delete(id);
      file = Promise.resolve(next);
      refreshCache(next);
      await save(path, next);
    }).catch((error: unknown) => {
      ctx.logger("dsh-config").warn("无法保存 Token 用量：%s", error instanceof Error ? error.message : String(error));
    });
  };

  ctx.on("session/event", account);
  const route: WebRoute = {
    kind: "exact",
    path: ROUTE,
    handler: async (request, response) => {
      if (request.headers[HEADER] !== HEADER_VALUE) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (etag !== "" && request.headers["if-none-match"] === etag) {
        response.writeHead(304).end();
        return;
      }
      const current = await file;
      if (serialized === null) {
        serialized = JSON.stringify({ ok: true, records: current.records });
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        etag
      });
      response.end(serialized);
    }
  };
  ctx.effect(() => ctx.webServer.register(route), "dsh-config: token calendar API");
}
