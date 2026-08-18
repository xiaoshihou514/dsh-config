import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'

interface CodexAuthFile {
  auth_mode?: unknown
  last_refresh?: unknown
  tokens?: {
    access_token?: unknown
    refresh_token?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface CodexTokenOptions {
  authFile?: string
  now?: () => number
}

const REFRESH_EARLY_MS = 5 * 60_000
let refreshInFlight: Promise<string> | undefined

export function codexAuthFile(): string {
  const root = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return join(root, 'auth.json')
}

function expiresAt(accessToken: string): number {
  try {
    const encoded = accessToken.split('.')[1]
    if (encoded === undefined) return 0
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

async function readAuth(path: string): Promise<CodexAuthFile> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`未找到 Codex 登录信息（${path}）；请先运行 codex login`, { cause: error })
  }
  try {
    return JSON.parse(source) as CodexAuthFile
  } catch (error) {
    throw new Error(`Codex 登录文件不是有效的 JSON（${path}）`, { cause: error })
  }
}

function credentials(auth: CodexAuthFile): OAuthCredential {
  if (auth.auth_mode !== 'chatgpt') {
    throw new Error('当前 Codex 不是通过 ChatGPT 订阅登录；请运行 codex login 并选择 ChatGPT 登录')
  }
  const access = auth.tokens?.access_token
  const refresh = auth.tokens?.refresh_token
  if (typeof access !== 'string' || access.length === 0 || typeof refresh !== 'string' || refresh.length === 0) {
    throw new Error('Codex 登录信息不完整；请重新运行 codex login')
  }
  return { type: 'oauth', access, refresh, expires: expiresAt(access) }
}

export async function hasCodexSubscription(path = codexAuthFile()): Promise<boolean> {
  try {
    credentials(await readAuth(path))
    return true
  } catch {
    return false
  }
}

export async function saveCodexCredentials(path: string, next: OAuthCredential): Promise<void> {
  let auth: CodexAuthFile = {}
  try {
    auth = await readAuth(path)
  } catch (error) {
    if ((error as { cause?: NodeJS.ErrnoException }).cause?.code !== 'ENOENT') throw error
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const updated: CodexAuthFile = {
    ...auth,
    auth_mode: 'chatgpt',
    last_refresh: new Date().toISOString(),
    tokens: {
      ...auth.tokens,
      access_token: next.access,
      refresh_token: next.refresh,
      ...typeof next.accountId === 'string' ? { account_id: next.accountId } : {},
    },
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

async function resolveToken(oauth: OAuthAuth, path: string, now: () => number): Promise<string> {
  const auth = await readAuth(path)
  const current = credentials(auth)
  if (current.expires > now() + REFRESH_EARLY_MS) return current.access

  const refreshed = await oauth.refresh(current)
  await saveCodexCredentials(path, refreshed)
  return refreshed.access
}

export async function codexSubscriptionAccessToken(
  oauth: OAuthAuth,
  options: CodexTokenOptions = {},
): Promise<string> {
  const path = options.authFile ?? codexAuthFile()
  const now = options.now ?? Date.now
  refreshInFlight ??= resolveToken(oauth, path, now).finally(() => {
    refreshInFlight = undefined
  })
  return refreshInFlight
}
