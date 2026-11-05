/**
 * 智能体办公室（宿主半侧）。
 *
 * - `GET /dsh-config/office?lead=<会话 id>`：从 Lead 与各成员会话推导
 *   {@link OfficeSnapshot}。已加载的会话读内存（最新），未加载的读持久化
 *   存储（按存储版本缓存摘要）。带 ETag，浏览器轮询时未变化返回 304。
 * - `POST /dsh-config/office/override`：手动指定成员的岗位 / 人设 / 档位（自动识别
 *   不准时用），持久化在 `$DSH_HOME/dsh-config/office-overrides.json`，按成员会话 id 记。
 * - `GET /dsh-config/office/teams`：组建过团队的会话（Lead），每个文件夹只保留最近组建的一个
 *   （`replaces` 列出被它取代的旧 Lead，前端据此把记住的旧团队换成新的），供全屏办公室切换项目。
 * - `GET /dsh-config/office/scene.js`：按需加载的 three.js 体素场景（ESM），带
 *   ETag（文件修改时间），浏览器协商缓存；重建后刷新即可生效。
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import {
  assembleSnapshot,
  digestSession,
  type LooseEvent,
  type SessionDigest,
} from "./office/derive.ts";
import { ROLE_LABEL, TIER_LABEL, VENDOR_LABEL } from "./office/classify.ts";
import type { OfficeMember, OfficeSnapshot, RoleKind, Tier, Vendor } from "./office/types.ts";

export const name = "dsh-config-agent-office";
export const inject = ["sessions", "webServer", "sessionPersistence"];

const ROUTE = "/dsh-config/office";
const SCENE_ROUTE = "/dsh-config/office/scene.js";
const OVERRIDE_ROUTE = "/dsh-config/office/override";
const TEAMS_ROUTE = "/dsh-config/office/teams";

/** 成员的手动指定；字段缺省 = 自动识别。 */
interface Override {
  role?: RoleKind;
  vendor?: Vendor;
  tier?: Tier;
}

function overridesFile(): string {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "dsh-config", "office-overrides.json");
}

/** 套用手动指定，并在 `detected` 里留下自动识别的结果供界面显示。 */
export function applyOverrides(snapshot: OfficeSnapshot, overrides: Readonly<Record<string, Override>>): OfficeSnapshot {
  return {
    ...snapshot,
    members: snapshot.members.map((member): OfficeMember => {
      const o = overrides[member.id];
      const detected = { vendor: member.vendor, tier: member.tier, roleKind: member.roleKind };
      if (o === undefined) return { ...member, detected };
      return {
        ...member,
        vendor: o.vendor ?? member.vendor,
        tier: o.tier ?? member.tier,
        // 组长的岗位固定
        roleKind: member.role === "lead" ? "lead" : (o.role ?? member.roleKind),
        detected,
        overridden: { role: o.role !== undefined && member.role !== "lead", vendor: o.vendor !== undefined, tier: o.tier !== undefined },
      };
    }),
  };
}
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
  list(): Promise<readonly { readonly header: { readonly id: string; readonly cwd?: string; readonly parentSession?: string; readonly origin?: string } }[]>;
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

  // ---- 手动指定
  let overrides: Record<string, Override> = {};
  let overridesVersion = 0;
  const overridesLoaded = readFile(overridesFile(), "utf8")
    .then((text) => {
      const parsed = JSON.parse(text) as { members?: Record<string, Override> };
      overrides = parsed.members ?? {};
    })
    .catch(() => {});
  let saving: Promise<void> = Promise.resolve();
  const saveOverrides = () => {
    saving = saving.then(async () => {
      const file = overridesFile();
      await mkdir(join(file, ".."), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, members: overrides }, null, 2));
      await rename(tmp, file);
    }).catch((error) => logger.warn("保存成员指定失败：%s", String(error)));
    return saving;
  };

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
    await overridesLoaded;
    const etag = `"${hash(`${leadId}|${keys.join("|")}|${[...loaded].sort().join(",")}|o${overridesVersion}`)}"`;
    return {
      etag,
      build: () =>
        applyOverrides(
          assembleSnapshot({
            leadId,
            lead: lead.digest,
            cwd: lead.cwd,
            members,
            loaded,
            now: Date.now(),
          }),
          overrides,
        ),
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

  /**
   * 团队列表：有子会话的顶层会话才可能是 Lead；读其日志（按存储版本缓存摘要），
   * 名册非空的就是一个团队。
   */
  const teamsRoute: WebRoute = {
    kind: "exact",
    path: TEAMS_ROUTE,
    handler: async (request, response) => {
      if (request.headers[HEADER] !== HEADER_VALUE) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      try {
        const stored = await persistence.list();
        const parents = new Set<string>();
        for (const { header } of stored)
          if (header.origin === "subagent" && header.parentSession !== undefined) parents.add(header.parentSession);
        const teams: {
          leadId: string;
          title?: string | undefined;
          cwd?: string | undefined;
          members: number;
          lastActiveAt?: number | undefined;
          /** 组建时间：最早一名成员的加入时间。 */
          formedAt: number;
          replaces: string[];
        }[] = [];
        await Promise.all(
          [...parents].map(async (id) => {
            const result = await digestOf(id, undefined);
            if (result === undefined || result.digest.team.length === 0) return;
            const memberTimes = await Promise.all(
              result.digest.team.map(async (m) => cache.get(m.id)?.digest.lastActiveAt ?? m.at),
            );
            teams.push({
              leadId: id,
              title: result.digest.title,
              cwd: result.cwd,
              members: result.digest.team.length + 1,
              lastActiveAt: Math.max(result.digest.lastActiveAt ?? 0, ...memberTimes),
              formedAt: Math.min(...result.digest.team.map((m) => m.at)),
              replaces: [],
            });
          }),
        );
        // 一个文件夹只算一个团队：保留最近组建的那个（重新组队就换成新团队，旧团队之后
        // 再活跃也不抢回来），被取代的旧 Lead 记在 replaces 里。
        const byCwd = new Map<string, (typeof teams)[number]>();
        for (const team of [...teams].sort((a, b) => b.formedAt - a.formedAt)) {
          const key = team.cwd ?? team.leadId;
          const newest = byCwd.get(key);
          if (newest === undefined) byCwd.set(key, team);
          else newest.replaces.push(team.leadId);
        }
        const unique = [...byCwd.values()].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
        respondJson(response, 200, {
          ok: true,
          teams: unique.map(({ formedAt: _formedAt, ...team }) => team),
        });
      } catch (error) {
        logger.warn("列出团队失败：%s", String(error));
        respondJson(response, 500, { ok: false, error: String(error) });
      }
    },
  };

  const overrideRoute: WebRoute = {
    kind: "exact",
    path: OVERRIDE_ROUTE,
    handler: async (request, response) => {
      if (request.headers[HEADER] !== HEADER_VALUE) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 4096) {
          response.writeHead(413).end();
          return;
        }
      }
      let input: { member?: unknown; role?: unknown; vendor?: unknown; tier?: unknown };
      try {
        input = JSON.parse(body) as typeof input;
      } catch {
        respondJson(response, 400, { ok: false, error: "请求体不是 JSON" });
        return;
      }
      const member = typeof input.member === "string" ? input.member : "";
      if (member.length === 0 || member.length > 200) {
        respondJson(response, 400, { ok: false, error: "缺少 member" });
        return;
      }
      // null = 恢复自动；undefined = 不改
      const pick = <T extends string>(value: unknown, allowed: Record<T, string>): T | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        return typeof value === "string" && value in allowed ? (value as T) : undefined;
      };
      const next: Override = { ...overrides[member] };
      const role = pick(input.role, ROLE_LABEL);
      const vendor = pick(input.vendor, VENDOR_LABEL);
      const tier = pick(input.tier, TIER_LABEL);
      if (role === null) delete next.role;
      else if (role !== undefined) next.role = role;
      if (vendor === null) delete next.vendor;
      else if (vendor !== undefined) next.vendor = vendor;
      if (tier === null) delete next.tier;
      else if (tier !== undefined) next.tier = tier;
      await overridesLoaded;
      if (Object.keys(next).length === 0) delete overrides[member];
      else overrides[member] = next;
      overridesVersion += 1;
      await saveOverrides();
      respondJson(response, 200, { ok: true, override: overrides[member] ?? null });
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
        // 协商缓存：未重建时 304，免得每次打开都重新下载 600KB。
        const info = await stat(sceneFile);
        const etag = `"${info.mtimeMs.toString(36)}-${info.size.toString(36)}"`;
        if (request.headers["if-none-match"] === etag) {
          response.writeHead(304, { etag, "cache-control": "no-cache" }).end();
          return;
        }
        const body = await readFile(sceneFile);
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": "text/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
          etag,
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
  ctx.effect(() => ctx.webServer.register(overrideRoute), "dsh-config: agent office overrides");
  ctx.effect(() => ctx.webServer.register(teamsRoute), "dsh-config: agent office teams");
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
