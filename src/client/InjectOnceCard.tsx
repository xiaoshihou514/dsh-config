import { useEffect, useState } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14 } from './icons.tsx'

export interface InjectOnceSettings {
  prompt?: string
}

export function InjectOnceCard({ scope }: { scope: SettingsScope<InjectOnceSettings> }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const refresh = () => {
    const value = scope.getSnapshot().value?.prompt ?? ''
    setDraft(value)
    setSaved(value)
  }

  useEffect(() => {
    refresh()
    return scope.subscribe(refresh)
  }, [])

  const dirty = draft !== saved
  const save = async () => {
    setSaving(true)
    setFailed(false)
    try {
      await scope.set('prompt', draft)
      setSaved(draft)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return <li style={{ listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-3)' }}>
    <button type="button" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}：单次提醒`} onClick={() => setOpen(!open)} style={{ width: '100%', appearance: 'none', border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12 }}>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>单次提醒</span>
        <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' }}>仅在会话开始及压缩后注入，并追加项目 AGENTS.md</span>
      </span>
      {dirty ? <span style={{ borderRadius: 999, padding: '1px 8px', fontSize: 11, background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)' }}>未保存</span> : null}
      <span style={{ color: 'var(--dsw-alias-label-tertiary)', transform: open ? 'rotate(180deg)' : undefined, display: 'inline-flex' }}><IconChevronDownOutline14 size={14} /></span>
    </button>
    {open ? <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', padding: '14px 0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={7} placeholder="输入需要偶尔提醒模型的内容…" style={{ resize: 'vertical', width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, lineHeight: 1.5 }} />
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }}>项目根目录的 AGENTS.md 会自动追加在全局提醒之后。普通轮次不会重复注入。</p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        {failed ? <p role="alert" style={{ flex: 1, margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-error)' }}>保存失败，请重试。</p> : null}
        <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(saved); setFailed(false) }} style={{ appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, background: 'none', color: 'var(--dsw-alias-label-secondary)', opacity: !dirty || saving ? 0.4 : 1 }}>放弃</button>
        <button type="button" disabled={!dirty || saving} onClick={() => void save()} style={{ appearance: 'none', border: '1px solid transparent', borderRadius: 8, padding: '5px 14px', font: 'inherit', fontSize: 13, background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', opacity: !dirty || saving ? 0.4 : 1 }}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </div> : null}
  </li>
}
