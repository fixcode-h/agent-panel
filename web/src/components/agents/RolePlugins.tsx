import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { packageIdentity } from '@shared/cli-spec'
import { getCli } from '@shared/clis'
import { t } from '@shared/i18n'
import { agentCli, defaultSettings } from '@shared/settings'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'

/** 一个角色最多带几个插件（和 shared/role-plugins.ts 的上限一致） */
const MAX = 10

/**
 * 角色级插件（ADR 0050 第四期）：这个角色执行时额外加载的 CLI 插件，不装进 CLI 的全局配置。
 * 只有角色用的 CLI 支持单次加载（定义里 packages.oneOff，例如 Pi 的 -e）时才显示；推荐的包列成快捷按钮
 */
export function RolePlugins({
  cli,
  value,
  onChange,
}: {
  cli: string
  value: string[] | undefined
  onChange: (v: string[]) => void
}) {
  const { settings } = useData()
  const [text, setText] = useState('')
  const def = getCli(agentCli({ cli }, settings ?? defaultSettings()))
  if (!def?.packages?.oneOff.length) return null
  const list = value ?? []
  const has = new Set(list.map(packageIdentity))
  const add = (source: string) => {
    const s = source.trim()
    if (!s || has.has(packageIdentity(s)) || list.length >= MAX) return
    onChange([...list, s])
    setText('')
  }
  const suggest = def.packages.recommended.filter((r) => !has.has(packageIdentity(r.source)))
  return (
    <Field
      label={t('额外加载的插件')}
      hint={t(
        '只在这个角色执行时加载，不装进 {cli} 的全局配置，别的角色看不到这些工具。第一次用到时 {cli} 要先下载，那一轮启动会慢一些',
        { cli: def.name },
      )}
    >
      <div className="flex flex-col gap-2">
        {list.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={t('额外加载的插件')}>
            {list.map((s) => (
              <li
                key={s}
                className="inline-flex items-center gap-1 rounded-md bg-sel/70 py-0.5 pr-1 pl-2 font-mono text-caption"
              >
                {s}
                <button
                  type="button"
                  aria-label={t('去掉 {name}', { name: s })}
                  onClick={() => onChange(list.filter((x) => x !== s))}
                  className="cursor-pointer rounded p-0.5 text-subtle hover:bg-sel hover:text-fg"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              add(text)
            }}
            placeholder={def.packages.placeholder}
            aria-label={t('插件来源')}
            className="flex-1 font-mono text-body"
            spellCheck={false}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={!text.trim() || list.length >= MAX}
            onClick={() => add(text)}
          >
            {t('添加')}
          </Button>
        </div>
        {suggest.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-caption text-subtle">
            {t('推荐：')}
            {suggest.map((r) => (
              <button
                key={r.source}
                type="button"
                onClick={() => add(r.source)}
                title={r.desc}
                className="inline-flex cursor-pointer items-center gap-0.5 rounded-md border px-1.5 py-0.5 hover:border-accent hover:text-accent-text"
              >
                <Plus className="h-3 w-3" />
                {r.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  )
}
