import { readFile, stat } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-config-inject-once'
export const inject = ['agents', 'settings']

const SETTINGS_NAMESPACE = settingsNamespace('dsh-config-inject-once')
const MAX_AGENTS_BYTES = 64 * 1024

export interface Config {
  /** Global reminder text injected before project instructions. */
  prompt?: string
}

export const Config = z.object({ prompt: z.string().default('') })

interface InjectOnceSource {
  kind: 'inject-once'
  cause: 'session-start' | 'compaction'
  compactionId?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'inject-once': InjectOnceSource
  }
}

export type InjectionCause =
  | { cause: 'session-start' }
  | { cause: 'compaction'; compactionId: string }

export function injectionCause(events: readonly SessionEvent[]): InjectionCause | undefined {
  let injectedAt = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message' && event.data.source.kind === 'inject-once') {
      injectedAt = index
      break
    }
  }
  for (let index = events.length - 1; index > injectedAt; index -= 1) {
    const event = events[index]
    if (event?.type === 'compaction/end' && event.data.error === undefined) {
      return { cause: 'compaction', compactionId: event.data.compactionId }
    }
  }
  return injectedAt < 0 ? { cause: 'session-start' } : undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function projectRoot(cwd: string): Promise<string> {
  const filesystemRoot = parse(cwd).root
  let current = cwd
  while (true) {
    if (await exists(join(current, '.git'))) return current
    if (current === filesystemRoot) return cwd
    current = dirname(current)
  }
}

export async function readProjectAgents(cwd: string | undefined): Promise<string> {
  if (cwd === undefined) return ''
  const path = join(await projectRoot(cwd), 'AGENTS.md')
  try {
    const content = await readFile(path)
    if (content.byteLength > MAX_AGENTS_BYTES) return ''
    return content.toString('utf8').trim()
  } catch {
    return ''
  }
}

export function renderInjectOnce(globalPrompt: string, agentsPrompt: string): string {
  const global = globalPrompt.trim()
  const local = agentsPrompt.trim()
  return [
    global.length > 0 ? `全局提醒：\n\n${global}` : '',
    local.length > 0 ? `项目 AGENTS.md：\n\n${local}` : '',
  ].filter(Boolean).join('\n\n')
}

function appendInjection(
  decision: Extract<PreStepDecision, { kind: 'enter' }>,
  message: UserMessage,
): PreStepDecision {
  return { kind: 'enter', messages: [...decision.messages, message] }
}

export function apply(ctx: Context, config: Config): void {
  const scope = ctx.settings.register(SETTINGS_NAMESPACE, Config)
  const globalPrompt = (): string => scope.get().prompt || config.prompt || ''

  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || decision.messages.length === 0 || signal.aborted) return decision
    const cause = injectionCause(agent.session.events)
    if (cause === undefined) return decision
    const text = renderInjectOnce(globalPrompt(), await readProjectAgents(agent.session.header.cwd))
    signal.throwIfAborted()
    if (text.length === 0) return decision
    return appendInjection(decision, createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'inject-once',
        cause: cause.cause,
        ...cause.cause === 'compaction' ? { compactionId: cause.compactionId } : {},
      },
    }))
  })
}
