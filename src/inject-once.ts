import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-config-inject-once";
export const inject = ["agents", "settings", "webServer"];

const INJECT_ROUTE = "/dsh-config/inject-once";
const HEADER = "x-dsh-config";
const HEADER_VALUE = "inject-once";
const MAX_AGENTS_BYTES = 64 * 1024;

/** 备忘录持久化到 ~/.dsh/dsh-config/inject-once.json（不依赖 settings 服务，重启不丢）。 */
function injectOncePath(): string {
  return join(
    process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
    "dsh-config",
    "inject-once.json",
  );
}

interface InjectOnceFile {
  version: 1;
  prompt: string;
}

async function loadPrompt(): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(injectOncePath(), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = parsed as Partial<InjectOnceFile>;
      if (candidate.version === 1 && typeof candidate.prompt === "string")
        return candidate.prompt;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return "";
}

async function savePrompt(prompt: string): Promise<void> {
  const path = injectOncePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file: InjectOnceFile = { version: 1, prompt };
  await writeFile(temporary, `${JSON.stringify(file)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export interface Config {
  /** Global reminder text injected before project instructions. */
  prompt?: string;
}

export const Config = z.object({ prompt: z.string().default("") });

interface InjectOnceSource {
  kind: "inject-once";
  cause: "session-start" | "compaction";
  compactionId?: string;
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "inject-once": InjectOnceSource;
  }
}

export type InjectionCause =
  | { cause: "session-start" }
  | { cause: "compaction"; compactionId: string };

export function injectionCause(
  events: readonly SessionEvent[],
): InjectionCause | undefined {
  let injectedAt = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === "user/message" &&
      event.data.source.kind === "inject-once"
    ) {
      injectedAt = index;
      break;
    }
  }
  for (let index = events.length - 1; index > injectedAt; index -= 1) {
    const event = events[index];
    if (event?.type === "compaction/end" && event.data.error === undefined) {
      return { cause: "compaction", compactionId: event.data.compactionId };
    }
  }
  return injectedAt < 0 ? { cause: "session-start" } : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function projectRoot(cwd: string): Promise<string> {
  const filesystemRoot = parse(cwd).root;
  let current = cwd;
  while (true) {
    if (await exists(join(current, ".git"))) return current;
    if (current === filesystemRoot) return cwd;
    current = dirname(current);
  }
}

export async function readProjectAgents(
  cwd: string | undefined,
): Promise<string> {
  if (cwd === undefined) return "";
  const path = join(await projectRoot(cwd), "AGENTS.md");
  try {
    const content = await readFile(path);
    if (content.byteLength > MAX_AGENTS_BYTES) return "";
    return content.toString("utf8").trim();
  } catch {
    return "";
  }
}

export function renderInjectOnce(
  globalPrompt: string,
  agentsPrompt: string,
): string {
  const global = globalPrompt.trim();
  const local = agentsPrompt.trim();
  return [
    global.length > 0 ? `全局提醒：\n\n${global}` : "",
    local.length > 0 ? `项目 AGENTS.md：\n\n${local}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function appendInjection(
  decision: Extract<PreStepDecision, { kind: "enter" }>,
  message: UserMessage,
): PreStepDecision {
  return { kind: "enter", messages: [...decision.messages, message] };
}

export function apply(ctx: Context, config: Config): void {
  /** 内存态即权威：启动时从 ~/.dsh 加载，保存后即时更新（写队列落后毫秒级）。 */
  let savedPrompt = "";
  let writes = Promise.resolve();
  void loadPrompt()
    .then((loaded) => {
      savedPrompt = loaded;
    })
    .catch((error: unknown) => {
      ctx
        .logger("dsh-config")
        .warn(
          "无法读取备忘录：%s",
          error instanceof Error ? error.message : String(error),
        );
    });
  const globalPrompt = (): string => savedPrompt || config.prompt || "";

  const route: WebRoute = {
    kind: "exact",
    path: INJECT_ROUTE,
    handler: async (request, response) => {
      if (request.headers[HEADER] !== HEADER_VALUE) {
        response.writeHead(403).end();
        return;
      }
      if (request.method === "GET") {
        await writes;
        respond(response, 200, { ok: true, prompt: globalPrompt() });
        return;
      }
      if (request.method === "PUT") {
        let payload: unknown;
        try {
          payload = JSON.parse(await readRequestBody(request));
        } catch {
          respond(response, 400, { ok: false, error: "invalid body" });
          return;
        }
        const body = payload as { prompt?: unknown };
        const prompt = body.prompt;
        if (typeof prompt !== "string" || prompt.length > 64 * 1024) {
          respond(response, 400, { ok: false, error: "invalid prompt" });
          return;
        }
        savedPrompt = prompt;
        writes = writes
          .then(() => savePrompt(prompt))
          .catch((error: unknown) => {
            ctx
              .logger("dsh-config")
              .warn(
                "无法保存备忘录：%s",
                error instanceof Error ? error.message : String(error),
              );
          });
        await writes;
        respond(response, 200, { ok: true, prompt: savedPrompt });
        return;
      }
      response.writeHead(405).end();
    },
  };
  ctx.effect(
    () => ctx.webServer.register(route),
    "dsh-config: inject-once memo API",
  );

  ctx.on(
    "agent/pre-step",
    async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next();
      if (
        decision.kind === "reject" ||
        decision.messages.length === 0 ||
        signal.aborted
      )
        return decision;
      const cause = injectionCause(agent.session.events);
      if (cause === undefined) return decision;
      const text = renderInjectOnce(
        globalPrompt(),
        await readProjectAgents(agent.session.header.cwd),
      );
      signal.throwIfAborted();
      if (text.length === 0) return decision;
      return appendInjection(
        decision,
        createUserMessage({
          content: [{ type: "text", text }],
          source: {
            kind: "inject-once",
            cause: cause.cause,
            ...(cause.cause === "compaction"
              ? { compactionId: cause.compactionId }
              : {}),
          },
        }),
      );
    },
  );
}

function respond(
  res: {
    writeHead(code: number, headers?: Record<string, string>): unknown;
    end(body?: string): unknown;
  },
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/** Read a request body up to a small cap. */
async function readRequestBody(request: {
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  on(event: "end", cb: () => void): unknown;
}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
