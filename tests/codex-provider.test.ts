import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { codexSubscriptionAccessToken } from '../src/codex-auth.ts'
import { CodexLoginManager, createCodexAdapter, PROVIDER } from '../src/codex-provider.ts'

function token(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`
}

function oauth(refresh: OAuthAuth['refresh']): OAuthAuth {
  return {
    name: '测试',
    login: async () => { throw new Error('本测试不会登录') },
    refresh,
    toAuth: async credential => ({ apiKey: credential.access }),
  }
}

describe('Codex 订阅凭据', () => {
  it('直接复用仍有效的 Codex CLI 登录令牌', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
    const authFile = join(root, 'auth.json')
    const access = token(2_000)
    await writeFile(authFile, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: access, refresh_token: 'refresh' },
    }))
    const refresh = vi.fn<OAuthAuth['refresh']>()

    await expect(codexSubscriptionAccessToken(oauth(refresh), {
      authFile,
      now: () => 1_000_000,
    })).resolves.toBe(access)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('刷新临近过期的令牌并写回 Codex CLI 登录文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-'))
    const authFile = join(root, 'auth.json')
    await writeFile(authFile, JSON.stringify({
      auth_mode: 'chatgpt',
      untouched: true,
      tokens: { access_token: token(1), refresh_token: 'old', account_id: 'account' },
    }))
    const next: OAuthCredential = {
      type: 'oauth', access: token(3_000), refresh: 'new', expires: 3_000_000,
    }

    await expect(codexSubscriptionAccessToken(oauth(async () => next), {
      authFile,
      now: () => 2_000_000,
    })).resolves.toBe(next.access)
    const saved = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, any>
    expect(saved.untouched).toBe(true)
    expect(saved.tokens).toMatchObject({ access_token: next.access, refresh_token: 'new', account_id: 'account' })
  })
})

describe('Codex 订阅提供方', () => {
  it('向 DSH 提供 Codex 模型目录', async () => {
    const models = await createCodexAdapter().listModels(PROVIDER)
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.provider === PROVIDER)).toBe(true)
  })

  it('可在 DSH 内发起 OAuth 并保存登录凭据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-login-'))
    const authFile = join(root, 'auth.json')
    const next: OAuthCredential = {
      type: 'oauth', access: token(3_000), refresh: 'new', expires: 3_000_000, accountId: 'account',
    }
    const loginOAuth = oauth(async credential => credential)
    loginOAuth.login = async (interaction) => {
      expect(await interaction.prompt({ type: 'select', message: '方式', options: [] })).toBe('browser')
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/test' })
      return next
    }
    const manager = new CodexLoginManager(loginOAuth, authFile)

    await expect(manager.start()).resolves.toMatchObject({ state: 'pending', url: 'https://auth.openai.com/test' })
    await vi.waitFor(() => expect(manager.status()).toEqual({ state: 'success' }))
    const saved = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, any>
    expect(saved).toMatchObject({
      auth_mode: 'chatgpt',
      tokens: { access_token: next.access, refresh_token: next.refresh, account_id: 'account' },
    })
  })
})
