/** Generate PNG images through the ChatGPT/Codex OAuth Responses endpoint. */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { codexSubscriptionAccessToken } from "./codex-auth.ts";

export const name = "dsh-config-codex-imagegen";
export const inject = ["tools"];

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_HOST_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_DIR = join(
  process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
  "generated-images",
);
const SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;

export interface Config {
  /** Responses API endpoint used by the Codex OAuth image tool. */
  baseUrl?: string;
  /** Image model requested through the hosted image_generation tool. */
  model?: string;
  /** Fallback directory when the tool is invoked without a session workspace. */
  outputDir?: string;
  /** Cooperative request timeout. */
  timeoutMs?: number;
}

export const Config = z.object({
  baseUrl: z.string().default(CODEX_RESPONSES_URL),
  model: z.string().default(DEFAULT_IMAGE_MODEL),
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
});

interface SseEvent {
  partial_image_b64?: unknown;
  item?: { result?: unknown; revised_prompt?: unknown };
  result?: unknown;
}

interface ImageResult {
  b64: string;
  revisedPrompt?: string;
}

function accountId(token: string): string {
  try {
    const encoded = token.split(".")[1];
    if (encoded === undefined) throw new Error("missing JWT payload");
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    const id =
      auth !== null && typeof auth === "object"
        ? (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id
        : undefined;
    if (typeof id !== "string" || id.trim() === "")
      throw new Error("missing chatgpt account id");
    return id;
  } catch (error) {
    throw new Error("Codex OAuth token 中没有 chatgpt_account_id", {
      cause: error,
    });
  }
}

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\n\n+/)) {
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data === "" || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed !== null && typeof parsed === "object")
        events.push(parsed as SseEvent);
    } catch {
      // Ignore non-JSON SSE keepalive/events; image results are JSON events.
    }
  }
  return events;
}

function collectImages(events: readonly SseEvent[]): ImageResult[] {
  const images: ImageResult[] = [];
  let lastPartial: string | undefined;
  for (const event of events) {
    if (
      typeof event.partial_image_b64 === "string" &&
      event.partial_image_b64.trim() !== ""
    )
      lastPartial = event.partial_image_b64.trim();
    const itemResult = event.item?.result;
    const result =
      typeof itemResult === "string" && itemResult.trim() !== ""
        ? itemResult.trim()
        : typeof event.result === "string" && event.result.trim() !== ""
          ? event.result.trim()
          : undefined;
    if (result === undefined) continue;
    images.push({
      b64: result,
      ...(typeof event.item?.revised_prompt === "string"
        ? { revisedPrompt: event.item.revised_prompt }
        : {}),
    });
  }
  if (images.length === 0 && lastPartial !== undefined)
    images.push({ b64: lastPartial });
  return images;
}

function render(args: unknown, value: unknown): ContentBlock[] {
  const result = value as {
    images: Array<{ path: string; revisedPrompt?: string }>;
  };
  return [
    {
      type: "text",
      text: result.images
        .map(
          (image) =>
            `已生成图片：${image.path}${image.revisedPrompt ? `\n修订提示词：${image.revisedPrompt}` : ""}`,
        )
        .join("\n\n"),
    },
  ];
}

function imageGenTool(
  config: Config,
  oauth: ReturnType<typeof openaiCodexProvider>["auth"]["oauth"],
) {
  if (oauth === undefined)
    throw new Error("Codex 模型提供方没有 OAuth 登录能力");
  return defineTool({
    name: "image_gen",
    description:
      "Generate one or more PNG images with the ChatGPT/Codex subscription. Available in any model session after Codex OAuth login. Returns local file paths.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "Detailed description of the image to generate.",
      },
      size: {
        type: "string",
        enum: [...SIZES],
        description: `Output size, default ${DEFAULT_SIZE}.`,
      },
      filename: {
        type: "string",
        description:
          "Optional PNG filename stem; generated files go under outputDir.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          images: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                revisedPrompt: { type: "string" },
              },
            },
          },
        },
      },
      render,
    },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const token = await codexSubscriptionAccessToken(oauth);
      const response = await fetch(config.baseUrl ?? CODEX_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "chatgpt-account-id": accountId(token),
          originator: "pi",
          "OpenAI-Beta": "responses=experimental",
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          "User-Agent": "pi (dsh-config-codex-imagegen)",
        },
        body: JSON.stringify({
          model: CODEX_HOST_MODEL,
          store: false,
          stream: true,
          instructions: "Generate the requested image. Do not add extra prose.",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: args.prompt }],
            },
          ],
          tools: [
            {
              type: "image_generation",
              model: config.model ?? DEFAULT_IMAGE_MODEL,
              size: args.size ?? DEFAULT_SIZE,
            },
          ],
          tool_choice: { type: "image_generation" },
        }),
        signal: exec.signal,
      });
      if (!response.ok)
        throw new Error(
          `Codex 图片生成失败（HTTP ${response.status}）：${await response.text()}`,
        );
      const images = collectImages(parseSse(await response.text()));
      if (images.length === 0) throw new Error("Codex 响应中没有图片结果");
      // Session workspace is the user's session directory; keep outputDir only
      // for headless calls without an agent/session workspace.
      const outputDir = resolve(
        exec.agent?.session.header.cwd ??
          config.outputDir ??
          DEFAULT_OUTPUT_DIR,
      );
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const stem =
        typeof args.filename === "string" && args.filename.trim() !== ""
          ? args.filename.trim().replace(/[^a-zA-Z0-9._-]/g, "-")
          : `image-${Date.now()}`;
      const saved: Array<{ path: string; revisedPrompt?: string }> = [];
      for (const [index, image] of images.entries()) {
        exec.signal.throwIfAborted();
        const suffix = images.length === 1 ? "" : `-${index + 1}`;
        const filename = `${stem}${suffix}${extname(stem) === ".png" ? "" : ".png"}`;
        const path = join(outputDir, filename);
        await writeFile(path, Buffer.from(image.b64, "base64"), {
          mode: 0o600,
        });
        saved.push({
          path,
          ...(image.revisedPrompt
            ? { revisedPrompt: image.revisedPrompt }
            : {}),
        });
      }
      return { images: saved };
    },
  });
}

/** Register the Codex OAuth image-generation tool. */
export function apply(ctx: Context, config: Config): void {
  const oauth = openaiCodexProvider().auth.oauth;
  if (oauth === undefined)
    throw new Error("Codex 模型提供方没有 OAuth 登录能力");
  ctx.tools.register(imageGenTool(config, oauth));
}
