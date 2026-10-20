import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, Download, Loader2, Package, RefreshCw } from 'lucide-react'
import { BUNDLED_CATEGORIES, type BundledSkill } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const STATUS_LABEL: Record<BundledSkill['status'][string], string> = {
  missing: t('未安装'),
  same: t('已安装'),
  changed: t('和自带的不同'),
}

/**
 * 面板自带的 Skill：按分类列出，统一看用户目录 ~/.agents/skills 里装了没有。
 * Agent 用到的自带 Skill 执行时会自动补齐，这里主要用来提前装好、或者把改过的换回自带的版本。
 */
export function BundledSkills({ query }: { query: string }) {
  const [items, setItems] = useState<BundledSkill[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const load = () =>
    api
      .bundledSkills()
      .then((d) => {
        setItems(d.items)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
  useEffect(() => {
    void load()
    // 只在打开时读一次，装完后由 install 重新读
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (items ?? []).filter((i) => !q || `${i.name} ${i.description}`.toLowerCase().includes(q))
    const cats = [...BUNDLED_CATEGORIES, ...[...new Set(list.map((i) => i.category))].map((id) => ({ id, label: id }))]
    return cats
      .filter((c, i) => cats.findIndex((x) => x.id === c.id) === i)
      .map((c) => ({ ...c, items: list.filter((i) => i.category === c.id) }))
      .filter((g) => g.items.length)
  }, [items, query])

  const install = async (names: string[], key: string, overwrite: boolean) => {
    setBusy(key)
    try {
      const r = await api.installBundled({ names, clis: [], overwrite })
      toast.success(r.done.length ? t('装好了 {n} 项', { n: r.done.length }) : t('都已经是最新的了'))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const need = (i: BundledSkill) => i.status.shared !== 'same'

  if (error) return <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
  if (!items) return <p className="text-[0.8125rem] text-subtle">{t('读取中…')}</p>
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3">
        <span className="text-[0.8125rem] text-muted">{t('装到')}</span>
        <span className="font-mono text-[0.8125rem] text-muted">~/.agents/skills</span>
        <span className="text-[0.75rem] text-subtle">{t('所有 CLI 共用')}</span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!!busy || !items.some((i) => i.status.shared === 'missing')}
          onClick={() =>
            void install(
              items.map((i) => i.name),
              'all',
              false,
            )
          }
          title={t('只装没有的，已经装了的不动')}
        >
          {busy === 'all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {t('安装全部未装的')}
        </Button>
      </div>
      {!groups.length && (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-[0.8125rem] text-subtle">
          {t('没有符合的{kind}。', { kind: 'Skill' })}
        </p>
      )}
      {groups.map((g) => (
        <section key={g.id} className="flex flex-col gap-2">
          <h2 className="px-1 text-[0.75rem] font-medium text-subtle">
            {g.label} · {g.items.length}
          </h2>
          <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
            {g.items.map((i) => {
              const changed = i.status.shared === 'changed'
              return (
                <li key={i.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                  <Package className="h-4 w-4 shrink-0 text-accent" />
                  <div className="min-w-0 flex-[1_1_260px]">
                    <p className="truncate font-mono text-[0.84375rem]">
                      {i.name}
                      {i.files > 0 && (
                        <span className="ml-2 font-sans text-[0.71875rem] text-subtle">
                          {t('另有 {n} 个文件', { n: i.files })}
                        </span>
                      )}
                    </p>
                    {i.description && <p className="line-clamp-2 text-[0.78125rem] text-muted">{i.description}</p>}
                  </div>
                  <span className="flex flex-wrap gap-1.5">
                    {i.status.shared !== 'missing' && (
                      <span
                        title={STATUS_LABEL[i.status.shared]}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-px text-[0.71875rem] text-muted',
                          changed && 'border-dashed',
                        )}
                      >
                        {STATUS_LABEL[i.status.shared]}
                        {i.status.shared === 'same' ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <RefreshCw className="h-3 w-3 text-warning" />
                        )}
                      </span>
                    )}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!!busy || !need(i)}
                    onClick={() => void install([i.name], i.name, true)}
                    title={changed ? t('用自带的版本覆盖（你改过的内容会丢掉）') : undefined}
                  >
                    {busy === i.name && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {!need(i) ? t('已安装') : changed ? t('更新') : t('安装')}
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
