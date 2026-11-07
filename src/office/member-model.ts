/**
 * 手动给团队成员换模型（宿主侧）。
 *
 * 原生模型选择器对「子智能体会话」整体禁用，宿主的 `selectModel` 远程接口也拒绝子智能体拥有的
 * 会话（而且会顺手把选择存成默认模型）。模型选择本身只是会话里的一条 `model/selection` 事件：
 * 它优先于创建时的 `agentOptions`，下一步起生效，续跑时也沿用。这里直接对成员的 Agent 记一条，
 * 不改默认模型。
 *
 * - `GET  /dsh-config/office/models`：已注册的供应商及其模型（分组，失败的供应商带 error）。
 * - `GET  /dsh-config/office/models?provider=&model=`：该模型可选的推理强度与默认值。
 * - `POST /dsh-config/office/model` `{ member, provider, model, reasoningEffort? }`：换模型。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

export const MODELS_ROUTE = "/dsh-config/office/models";
export const MODEL_ROUTE = "/dsh-config/office/model";
const HEADER = "x-dsh-config";
const HEADER_VALUE = "agent-office";
const CATALOG_TTL_MS = 60_000;

interface Selection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

interface LlmLike {
  listProviders(): { id: string; name: string }[];
  listModels(provider: string): Promise<{ id: string; name: string; description?: string }[]>;
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string } }>;
  resolveCallConfig(config: Selection, signal?: AbortSignal): Promise<unknown>;
}

interface AgentLike {
  readonly id: string;
  readonly model?: { select(selection: Selection): void };
}

interface SessionLike {
  readonly header: { readonly parentSession?: string };
  append(type: string, data: unknown): unknown;
}

export interface CatalogGroup {
  readonly provider: string;
  readonly name: string;
  readonly models: readonly { id: string; name: string }[];
  readonly error?: string;
}

function respondJson(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

/** 校验请求体；不合法返回错误文字。 */
export function parseSelection(input: unknown): { member: string; selection: Selection } | string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "请求体不是对象";
  const value = input as Record<string, unknown>;
  const text = (key: string, max: number): string | undefined => {
    const raw = value[key];
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 || trimmed.length > max ? undefined : trimmed;
  };
  const member = text("member", 200);
  const provider = text("provider", 200);
  const model = text("model", 300);
  const effort = text("reasoningEffort", 100);
  if (member === undefined) return "缺少 member";
  if (provider === undefined || model === undefined) return "缺少 provider / model";
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null && effort === undefined)
    return "reasoningEffort 不合法";
  return { member, selection: { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) } };
}

export function registerMemberModelRoutes(ctx: Context, logger: { warn(format: string, ...args: unknown[]): void }): void {
  const llm = () => ctx.get("llm" as never) as LlmLike | undefined;
  const agents = () => ctx.get("agents" as never) as { get(id: string): AgentLike | undefined } | undefined;
  const sessions = () => ctx.get("sessions" as never) as { get(id: string): SessionLike | undefined } | undefined;

  let catalog: { at: number; value: Promise<CatalogGroup[]> } | undefined;
  const loadCatalog = (service: LlmLike): Promise<CatalogGroup[]> => {
    if (catalog !== undefined && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.value;
    const value = Promise.all(
      service.listProviders().map(async (provider): Promise<CatalogGroup> => {
        try {
          const models = await service.listModels(provider.id);
          return { provider: provider.id, name: provider.name, models: models.map((m) => ({ id: m.id, name: m.name })) };
        } catch (error) {
          return { provider: provider.id, name: provider.name, models: [], error: String(error) };
        }
      }),
    );
    catalog = { at: Date.now(), value };
    value.catch(() => {
      catalog = undefined;
    });
    return value;
  };

  const modelsRoute: WebRoute = {
    kind: "exact",
    path: MODELS_ROUTE,
    handler: async (request, response) => {
      if (request.headers[HEADER] !== HEADER_VALUE) {
        response.writeHead(403).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      const service = llm();
      if (service === undefined) {
        respondJson(response, 503, { ok: false, error: "LLM 服务不可用" });
        return;
      }
      const params = new URL(request.url ?? "/", "http://x").searchParams;
      const provider = params.get("provider");
      const model = params.get("model");
      try {
        if (provider !== null && model !== null) {
          const info = await service.resolveModelInfo(provider, model);
          respondJson(response, 200, {
            ok: true,
            efforts: info.reasoning?.efforts.map((e) => ({ id: e.id, name: e.name })) ?? [],
            defaultEffort: info.reasoning?.defaultEffort,
          });
          return;
        }
        respondJson(response, 200, { ok: true, groups: await loadCatalog(service) });
      } catch (error) {
        respondJson(response, 500, { ok: false, error: String(error) });
      }
    },
  };

  const modelRoute: WebRoute = {
    kind: "exact",
    path: MODEL_ROUTE,
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
      let parsed: ReturnType<typeof parseSelection>;
      try {
        parsed = parseSelection(JSON.parse(body));
      } catch {
        parsed = "请求体不是 JSON";
      }
      if (typeof parsed === "string") {
        respondJson(response, 400, { ok: false, error: parsed });
        return;
      }
      const { member, selection } = parsed;
      const service = llm();
      if (service === undefined) {
        respondJson(response, 503, { ok: false, error: "LLM 服务不可用" });
        return;
      }
      try {
        // 线路、推理强度不合法时这里就报错，不写进会话
        await service.resolveCallConfig(selection);
      } catch (error) {
        respondJson(response, 400, { ok: false, error: `模型不可用：${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      try {
        const agent = agents()?.get(member);
        if (agent?.model !== undefined) {
          agent.model.select(selection);
        } else {
          const session = sessions()?.get(member);
          if (session === undefined) {
            respondJson(response, 409, {
              ok: false,
              error: "这个成员现在没有加载（dsh 重启后要等组长恢复它），先给他发条消息或打开组长对话再试",
            });
            return;
          }
          session.append("model/selection", selection);
        }
        respondJson(response, 200, { ok: true, selected: selection });
      } catch (error) {
        logger.warn("给成员 %s 换模型失败：%s", member, String(error));
        respondJson(response, 500, { ok: false, error: String(error) });
      }
    },
  };

  const web = ctx as unknown as { webServer: { register(route: WebRoute): () => void } };
  ctx.effect(() => web.webServer.register(modelsRoute), "dsh-config: agent office models");
  ctx.effect(() => web.webServer.register(modelRoute), "dsh-config: agent office member model");
}
