import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, FileText, Loader2, Package, RefreshCw } from 'lucide-react'
import type { BundledSkill, LibraryEntryContent } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useNav } from '@/lib/data'
import { useSkillUpdates } from '@/lib/skill-updates'
import { BUNDLED_STATUS_LABEL } from '@/lib/use-bundled-skills'
import { countFiles, entryName, toTree, visibleRows } from '@/lib/library-tree'
import { fileIcon } from '@/lib/file-icon'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { DetailEmpty } from '@/components/layout/Detail'
import { categoryLabel } from '@/components/library/BundledSkills'

/** 装到用户目录里的位置：所有 Agent 共用这一份 */
const SHARED_DIR = '~/.agents/skills'

/**
 * 自带 Skill 的详情页：名称、分类、说明、装在哪、文件结构和文件内容。
 * 内容只读——它是随面板版本发布的那一份（仓库 skills/），改了既会被下次更新覆盖、
 * 也不影响真正生效的 ~/.agents/skills 那份，所以这里只展示、不给编辑框。
 */
export function BundledDetail({
  item,
  busy,
  onInstall,
}: {
  item: BundledSkill
  /** 正在安装的项名（页面统一管，左栏的批量按钮也用这个） */
  busy: string
  onInstall: (names: string[], key: string, overwrite: boolean) => void
}) {
  const [picked, setPicked] = useState('')
  const [file, setFile] = useState<LibraryEntryContent | null>(null)
  const [error, setError] = useState('')
  /** 打开文件的请求序号：连点时只认最后一次 */
  const opened = useRef(0)
  /** 收起的目录：默认全展开（技能文件夹通常只有几个文件），和普通 Skill 的文件树同一个行为 */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  // 树最多 1000 条：按 item.tree 缓存一份，输入内容时不用每次重算
  const rows = useMemo(() => toTree(item.tree?.entries ?? []), [item.tree])
  const changed = item.status.shared === 'changed'
  const { openSettings } = useNav()
  // 部署到「分类/名字」的那份要在设置里更新：这里指过去，免得用户在这一页找不到
  const deployed = useSkillUpdates().deployed.includes(item.name)

  // 换技能：清空选中的文件，不带着上一个技能的内容
  useEffect(() => {
    opened.current++
    setPicked('')
    setFile(null)
    setError('')
    setFolded(new Set())
  }, [item.name])

  const open = (path: string) => {
    setPicked(path)
    setFile(null)
    setError('')
    const seq = ++opened.current
    api
      .bundledEntry(item.name, path)
      .then((c) => {
        if (seq !== opened.current) return
        setFile(c)
      })
      .catch((e) => {
        if (seq !== opened.current) return
        setPicked('')
        setError((e as Error).message)
      })
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-y-auto">
      <header className="flex flex-wrap items-start gap-3 border-b bg-bg px-4 py-5 md:px-8">
        <Package className="mt-1 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-[1_1_260px]">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-mono text-lg font-semibold">{item.name}</h2>
            <span className="rounded-full border bg-card px-2 py-px text-[0.71875rem] text-muted">
              {t('自带 Skill')}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-px text-[0.71875rem] text-muted',
                changed && 'border-dashed',
              )}
            >
              {BUNDLED_STATUS_LABEL[item.status.shared]}
              {item.status.shared === 'same' ? (
                <Check className="h-3 w-3 text-success" />
              ) : item.status.shared === 'changed' ? (
                <RefreshCw className="h-3 w-3 text-warning" />
              ) : null}
            </span>
          </div>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">{item.description || t('没有说明')}</p>
          <p className="mt-0.5 truncate font-mono text-[0.71875rem] text-subtle">
            {SHARED_DIR}/{item.name}/SKILL.md
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => onInstall([item.name], item.name, true)}
            disabled={!!busy || item.status.shared === 'same'}
            title={changed ? t('用自带的版本覆盖（你改过的内容会丢掉）') : undefined}
          >
            {busy === item.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {item.status.shared === 'same' ? t('已安装') : changed ? t('更新') : t('安装')}
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5 px-4 pt-6 pb-12 md:px-8">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] text-muted">
          <span className="text-subtle">{t('分类')}</span>
          <span>{categoryLabel(item.category)}</span>
          <span className="text-subtle">·</span>
          <span className="text-subtle">{t('装在')}</span>
          <span className="font-mono">{SHARED_DIR}</span>
          <span className="text-subtle">{t('（所有 Agent 共用）')}</span>
        </div>

        {/* 自带技能的内容由面板随版本提供：说明清楚为什么这里不能编辑，不留一个空详情页 */}
        <p className="rounded-xl border border-dashed px-4 py-3 text-[0.8125rem] leading-relaxed text-muted">
          {t('自带技能的内容由面板随版本提供，不能在这里编辑；修改请复制一份放到自己的技能目录里。')}
        </p>
        {deployed && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-accent/40 bg-accent-soft/40 px-4 py-3">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed">
              {t('这个技能还有一份部署在「设置 → 部署」，那份要覆盖部署一次才会更新。')}
            </span>
            <Button size="sm" variant="secondary" onClick={() => openSettings('deploy')}>
              {t('去部署')}
            </Button>
          </div>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[0.8125rem] font-medium">{t('文件结构')}</h3>
            {rows.length > 0 && (
              <span className="text-[0.75rem] text-subtle">{t('另有 {n} 个文件', { n: countFiles(rows) })}</span>
            )}
          </div>
          <div className="flex flex-col gap-3 lg:flex-row">
            <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-card shadow-card p-1.5 lg:w-[260px] lg:shrink-0">
              {/* 主文件也列在树里：自带技能的内容只读，不存在「主文件在别处编辑」 */}
              <button
                type="button"
                onClick={() => open('')}
                aria-current={picked === '' && file ? true : undefined}
                title="SKILL.md"
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.8125rem]',
                  picked === '' && file ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/60',
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="truncate font-mono">SKILL.md</span>
              </button>
              {visibleRows(rows, folded).map((r) => {
                const isDir = r.type === 'dir'
                // 目录用展开 / 收起的箭头，文件按扩展名挑图标
                const Icon = isDir ? (folded.has(r.path) ? ChevronRight : ChevronDown) : fileIcon(r.path)
                return (
                  <button
                    key={r.path}
                    type="button"
                    onClick={() => (isDir ? setFolded((s) => toggle(s, r.path)) : open(r.path))}
                    aria-expanded={isDir ? !folded.has(r.path) : undefined}
                    aria-current={picked === r.path || undefined}
                    title={r.path}
                    style={{ paddingLeft: 8 + r.depth * 14 }}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[0.8125rem]',
                      picked === r.path ? 'bg-sel text-fg' : 'hover:bg-sel/60',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', isDir ? 'text-subtle' : 'text-accent')} />
                    <span className={cn('truncate', isDir ? 'text-muted' : 'font-mono')}>{entryName(r.path)}</span>
                  </button>
                )
              })}
              {item.tree?.truncated && (
                <p className="px-2 py-2 text-[0.75rem] text-subtle">{t('文件太多，只显示了前面一部分。')}</p>
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {error ? (
                <p className="text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
              ) : file === null ? (
                <EmptyPanel>
                  {rows.length
                    ? t('在左边的文件树里点一个文件，看它的内容。')
                    : t('这个技能只有 SKILL.md，点左上的 SKILL.md 看内容。')}
                </EmptyPanel>
              ) : file.binary ? (
                <EmptyPanel>{t('二进制文件（{bytes} 字节），不显示内容。', { bytes: file.size })}</EmptyPanel>
              ) : (
                <>
                  <span className="truncate font-mono text-[0.75rem] text-subtle">{file.path || 'SKILL.md'}</span>
                  <pre className="max-h-[min(60vh,560px)] overflow-auto rounded-xl bg-card shadow-card p-4 font-mono text-[0.78125rem] leading-relaxed whitespace-pre-wrap">
                    {file.content}
                  </pre>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

/** 收起的目录集合：点一下目录就切换 */
const toggle = (s: ReadonlySet<string>, path: string) => {
  const next = new Set(s)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/** 没选中任何自带技能时的空态：告诉用户在左边点一项 */
export function BundledEmpty() {
  return (
    <DetailEmpty icon={<Package className="h-6 w-6" />} title={t('自带 Skill')}>
      <p>{t('在左边选一个技能，看它带哪些文件、装没装。')}</p>
    </DetailEmpty>
  )
}
