/**
 * 智能体办公室（宿主半侧）。
 *
 * - `GET /dsh-config/office?lead=<会话 id>`：从 Lead 与各成员会话推导
 *   {@link OfficeSnapshot}。已加载的会话读内存（最新），未加载的读持久化
 *   存储（按存储版本缓存摘要）。带 ETag，浏览器轮询时未变化返回 304。
 * - `GET /dsh-config/office/scene.js`：按需加载的 three.js 体素场景（ESM），
 *   每次从磁盘读取，重建后刷新即可生效。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import {
  assembleSnapshot,
  digestSession,
  type LooseEvent,
  type SessionDigest,
} from "./office/derive.ts";

export const name = "dsh-config-agent-office";
export const inject = ["sessions", "webServer", "sessionPersistence"];

const ROUTE = "/dsh-config/office";
const SCENE_ROUTE = "/dsh-config/office/scene.js";
const HEADER = "x-dsh-config";
const HEADER_VALUE = "agent-office";

/** 宿主内存中的会话（只用到这几个成员）。 */
interface LiveSession {
  readonly id: string;
  readonly seq: number;
  readonly header: { readonly cwd?: string; readonly parentSession?: string };
  readonly inheritedEventCount: number;
  ownEvents(): readonly LooseEvent[];
}

interface ReadHandle {
  readonly header: { readonly cwd?: string; readonly parentSession?: string };
  readonly inheritedEventCount: number;
  read(): Promise<{ readonly events: readonly LooseEvent[] }>;
  close(): Promise<void>;
}

interface PersistenceLike {
  stat(id: string): Promise<{ readonly revision: unknown; readonly eventCount?: number } | undefined>;
  open(id: string, access: "read"): Promise<ReadHandle>;
}

interface SessionsLike {
  get(id: string): LiveSession | undefined;
}

interface CachedDigest {
  readonly key: string;
  readonly digest: SessionDigest;
  readonly cwd?: string | undefined;
}

function respondJson(
  response: import("node:http").ServerResponse,
  status: number,
  payload: unknown,
  etag?: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...(etag === undefined ? {} : { etag }),
  });
  response.end(JSON.stringify(payload));
}

export function apply(ctx: Context): void {
  const logger = ctx.logger("dsh-config-agent-office");
  const sessions = (ctx as unknown as { sessions: SessionsLike }).sessions;
  const persistence = (ctx as unknown as { sessionPersistence: PersistenceLike })
    .sessionPersistence;
  const cache = new Map<string, CachedDigest>();

  /** 读一个会话的摘要；返回缓存键（变化即重算）。读不到返回 undefined。 */
  async function digestOf(
    id: string,
    parentId: string | undefined,
  ): Promise<{ digest: SessionDigest; key: string; cwd?: string | undefined; loaded: boolean } | undefined> {
    const live = sessions.get(id);
    if (live !== undefined) {
      const key = `live:${live.seq}`;
      const hit = cache.get(id);
      if (hit?.key === key) return { ...hit, loaded: true };
      const digest = digestSession(id, live.ownEvents(), parentId);
      const entry = { key, digest, cwd: live.header.cwd };
      cache.set(id, entry);
      return { ...entry, loaded: true };
    }
    let stat;
    try {
      stat = await persistence.stat(id);
    } catch (error) {
      logger.warn("读取会话 %s 状态失败：%s", id, String(error));
      return undefined;
    }
    if (stat === undefined) return undefined;
    const key = `disk:${String(stat.revision)}:${stat.eventCount ?? ""}`;
    const hit = cache.get(id);
    if (hit?.key === key) return { ...hit, loaded: false };
    let handle: ReadHandle | undefined;
    try {
      handle = await persistence.open(id, "read");
      const { events } = await handle.read();
      const own = events.slice(handle.inheritedEventCount);
      const digest = digestSession(id, own, parentId);
      const entry = { key, digest, cwd: handle.header.cwd };
      cache.set(id, entry);
      return { ...entry, loaded: false };
    } catch (error) {
      logger.warn("读取会话 %s 失败：%s", id, String(error));
      return undefined;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function snapshot(leadId: string) {
    const lead = await digestOf(leadId, undefined);
    if (lead === undefined) return undefined;
    const members = new Map<string, SessionDigest>();
    const loaded = new Set<string>();
    const keys = [lead.key];
    if (lead.loaded) loaded.add(leadId);
    await Promise.all(
      lead.digest.team.map(async (entry) => {
        const result = await digestOf(entry.id, leadId);
        if (result === undefined) return;
        members.set(entry.id, result.digest);
        if (result.loaded) loaded.add(entry.id);
      }),
    );
    for (const entry of lead.digest.team) keys.push(cache.get(entry.id)?.key ?? "-");
    const etag = `"${hash(`${leadId}|${keys.join("|")}|${[...loaded].sort().join(",")}`)}"`;
    return {
      etag,
      build: () =>
        assembleSnapshot({
          leadId,
          lead: lead.digest,
          cwd: lead.cwd,
          members,
          loaded,
          now: Date.now(),
        }),
    };
  }

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
      const leadId = new URL(request.url ?? "/", "http://x").searchParams.get("lead");
      if (leadId === null || leadId.length === 0 || leadId.length > 200) {
        respondJson(response, 400, { ok: false, error: "缺少 lead 参数" });
        return;
      }
      try {
        const result = await snapshot(leadId);
        if (result === undefined) {
          respondJson(response, 404, { ok: false, error: "找不到该会话" });
          return;
        }
        if (request.headers["if-none-match"] === result.etag) {
          response.writeHead(304, { etag: result.etag }).end();
          return;
        }
        respondJson(response, 200, { ok: true, snapshot: result.build() }, result.etag);
      } catch (error) {
        logger.warn("生成办公室快照失败：%s", String(error));
        respondJson(response, 500, { ok: false, error: String(error) });
      }
    },
  };

  const sceneFile = fileURLToPath(new URL("./office-scene.js", import.meta.url));
  const sceneRoute: WebRoute = {
    kind: "exact",
    path: SCENE_ROUTE,
    handler: async (request, response) => {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      try {
        const body = await readFile(sceneFile);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(body);
      } catch (error) {
        logger.warn("读取场景脚本失败：%s", String(error));
        response.writeHead(404).end();
      }
    },
  };

  ctx.effect(() => ctx.webServer.register(route), "dsh-config: agent office API");
  ctx.effect(() => ctx.webServer.register(sceneRoute), "dsh-config: agent office scene");
}

/** FNV-1a，用于 ETag。 */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}
