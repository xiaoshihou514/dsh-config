import type { Context } from '@deepseek-ai/cordis'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { codexSubscriptionAccessToken } from './codex-auth.ts'

export const name = 'dsh-config-codex-provider'
export const inject = ['llm']

export const PROVIDER = 'openai-codex'

export function createCodexAdapter(): PiAiAdapter {
  const catalogProvider = openaiCodexProvider()
  const oauth = catalogProvider.auth.oauth
  if (oauth === undefined) throw new Error('Codex 模型提供方没有提供订阅登录能力')
  // PiAiAdapter supplies a per-request token through its API-key override.
  // Codex is OAuth-only in the upstream catalog, so expose that override as a
  // request-scoped auth method while retaining the native OAuth implementation
  // for refreshes. No token is discovered from the environment.
  const piProvider: typeof catalogProvider = {
    ...catalogProvider,
    auth: {
      ...catalogProvider.auth,
      apiKey: {
        name: 'Codex 订阅令牌',
        resolve: async ({ credential }) => credential?.key === undefined
          ? undefined
          : { auth: { apiKey: credential.key }, source: 'Codex CLI 登录' },
      },
    },
  }

  const profile: ResolvedPiAiProviderProfile = {
    provider: PROVIDER,
    displayName: 'Codex 订阅',
    streamIdleTimeoutMs: 300_000,
    retryPolicy: resolveRetryPolicy(undefined, 'Codex 订阅重试策略'),
    piProvider,
    configuredMaxTokens: new Map(),
  }
  const profiles = new Map([[PROVIDER, profile]])

  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => codexSubscriptionAccessToken(oauth),
  })
}

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROVIDER], createCodexAdapter())
}
