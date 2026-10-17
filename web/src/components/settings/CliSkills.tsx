import { useEffect, useState } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import type { CliSkill } from '@shared/schema'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { t } from '@shared/i18n'

const scopeName = (s: string) =>
  ({
    user: t('用户'),
    repo: t('项目'),
    project: t('项目'),
    plugin: t('插件'),
    system: t('自带'),
    admin: t('管理员'),
  })[s.toLowerCase()] ?? s

/** 按来源目录分组，保持服务端给的顺序 */
function groups(list: CliSkill[]) {
  const m = new Map<string, CliSkill[]>()
  for (const s of list) (m.get(s.source ?? '') ?? m.set(s.source ?? '', []).get(s.source ?? '')!).push(s)
  return [...m]
}

/** CLI 能用的 Skill：Codex 问 app-server，其他 CLI 读 Skill 目录；projectId 给了时也列项目里的 */
export function CliSkills({ cli, projectId = '' }: { cli: string; projectId?: string }) {
  const [list, setList] = useState<CliSkill[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = () => {
    setLoading(true)
    api
      .cliSkills(cli, projectId)
      .then((l) => {
        setList(l)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    setList(null)
    load()
    // load 每次渲染都是新的函数，只在 CLI 或项目变化时重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, projectId])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center text-[12px] text-subtle">
        {list && t('共 {n} 个', { n: list.length })}
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 text-accent"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          {t('刷新')}
        </button>
      </div>
      {error ? (
        <p className="text-[12px] text-warning">{t('读取失败：{error}', { error })}</p>
      ) : !list ? (
        <p className="text-[12px] text-subtle">{t('读取中…')}</p>
      ) : !list.length ? (
        <p className="text-[12px] text-subtle">{t('还没有装 Skill')}</p>
      ) : (
        // 按目录分组：.agents 下共用的和 CLI 自己目录下的分开列
        <div className="flex flex-col gap-3">
          {groups(list).map(([source, items]) => (
            <div key={source} className="flex flex-col gap-1.5">
              <p className="flex items-center gap-2 text-[11.5px] text-subtle">
                <span className="truncate font-mono">{source || t('插件')}</span>
                <span className="shrink-0">{items.length}</span>
              </p>
              <ul className="flex flex-col divide-y rounded-lg border">
                {items.map((s) => (
                  <li key={s.path || s.name} className="flex items-start gap-2.5 px-3 py-2" title={s.path}>
                    <Sparkles
                      className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', s.enabled ? 'text-accent' : 'text-subtle')}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-[13px]">
                        <span className={cn('truncate font-mono', !s.enabled && 'text-subtle line-through')}>
                          {s.name}
                        </span>
                        {s.scope && (
                          <span className="shrink-0 rounded-full bg-sel px-1.5 py-px text-[10.5px] text-muted">
                            {scopeName(s.scope)}
                          </span>
                        )}
                      </p>
                      {s.description && <p className="line-clamp-2 text-[12px] text-muted">{s.description}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
