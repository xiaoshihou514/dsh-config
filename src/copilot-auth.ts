import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

export interface CopilotTokenOptions {
  authFile?: string;
  now?: () => number;
}

/** Copilot 会话令牌约 30 分钟有效，提前 5 分钟刷新。 */
const REFRESH_EARLY_MS = 5 * 60_000;
let refreshInFlight: Promise<string> | undefined;

export function copilotAuthFile(): string {
  const root = process.env.COPILOT_HOME?.trim() || join(homedir(), ".dsh");
  return join(root, "copilot", "auth.json");
}

/**
 * 凭据文件即 pi-ai 的 OAuthCredential JSON：refresh 是长期有效的 GitHub
 * OAuth 令牌，access 是短期 Copilot 会话令牌，availableModelIds/enterpriseUrl
 * 等扩展字段随刷新回写（OAuthCredential 带索引签名，JSON 往返无损）。
 */
async function readAuth(path: string): Promise<OAuthCredential> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`未找到 Copilot 登录信息（${path}）；请先在设置中登录`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Copilot 登录文件不是有效的 JSON（${path}）`, {
      cause: error,
    });
  }
  const auth = parsed as Partial<OAuthCredential>;
  if (
    auth.type !== "oauth" ||
    typeof auth.refresh !== "string" ||
    auth.refresh.length === 0 ||
    typeof auth.access !== "string" ||
    auth.access.length === 0 ||
    typeof auth.expires !== "number"
  ) {
    throw new Error(`Copilot 登录信息不完整（${path}）；请重新登录`);
  }
  return auth as OAuthCredential;
}

export async function hasCopilotSubscription(
  path = copilotAuthFile(),
): Promise<boolean> {
  try {
    await readAuth(path);
    return true;
  } catch {
    return false;
  }
}

export async function saveCopilotCredentials(
  path: string,
  credential: OAuthCredential,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function resolveToken(
  oauth: OAuthAuth,
  path: string,
  now: () => number,
): Promise<string> {
  const current = await readAuth(path);
  if (current.expires > now() + REFRESH_EARLY_MS) return current.access;

  const refreshed = await oauth.refresh(current, AbortSignal.timeout(30_000));
  await saveCopilotCredentials(path, refreshed);
  return refreshed.access;
}

/** 每请求解析 Copilot 会话令牌：临近过期时用 GitHub OAuth 令牌换发并回写。 */
export async function copilotSubscriptionAccessToken(
  oauth: OAuthAuth,
  options: CopilotTokenOptions = {},
): Promise<string> {
  const path = options.authFile ?? copilotAuthFile();
  const now = options.now ?? Date.now;
  refreshInFlight ??= resolveToken(oauth, path, now).finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}
