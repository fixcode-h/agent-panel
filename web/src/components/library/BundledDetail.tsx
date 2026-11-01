import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Download, FileText, Loader2, Package, RefreshCw } from 'lucide-react'
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
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DetailEmpty, DetailHeader } from '@/components/layout/Detail'
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
      <DetailHeader
        compact
        quietSave
        leading={
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
            <Package className="h-5 w-5" />
          </span>
        }
        title={item.name}
        meta={
          <>
            <Badge className="text-caption">{t('自带 Skill')}</Badge>
            {/* 和自带版本不一样（被改过）换成警告色，不靠虚线边框区分 */}
            <Badge tone={changed ? 'warning' : 'neutral'} className="gap-1.5 text-caption">
              {BUNDLED_STATUS_LABEL[item.status.shared]}
              {item.status.shared === 'same' ? (
                <Check className="h-3 w-3 text-success" />
              ) : item.status.shared === 'changed' ? (
                <RefreshCw className="h-3 w-3 text-warning" />
              ) : null}
            </Badge>
          </>
        }
        subtitle={item.description || t('没有说明')}
        save={{ status: 'idle', error: '' }}
        actions={
          <Button
            size="sm"
            variant={item.status.shared === 'missing' ? 'primary' : 'secondary'}
            onClick={() => onInstall([item.name], item.name, true)}
            disabled={!!busy || item.status.shared === 'same'}
            title={changed ? t('用自带的版本覆盖（你改过的内容会丢掉）') : undefined}
          >
            {busy === item.name ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : item.status.shared === 'missing' ? (
              <Download className="h-4 w-4" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {item.status.shared === 'same' ? t('已安装') : changed ? t('更新') : t('安装')}
          </Button>
        }
      />

      <div className="flex w-full max-w-[1100px] flex-col gap-4 px-4 pt-5 pb-12 md:px-8">
        {/* 分类、装在哪、为什么不能编辑并成一行：原来三行加一块灰底说明，占了半屏 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-muted">
          <span className="text-subtle">{t('分类')}</span>
          <span>{categoryLabel(item.category)}</span>
          <span className="text-subtle">·</span>
          <span className="text-subtle">{t('装在')}</span>
          <span className="font-mono">
            {SHARED_DIR}/{item.name}
          </span>
          <span className="text-subtle">{t('（所有 Agent 共用）')}</span>
          <span className="text-subtle">·</span>
          <span className="text-subtle">{t('随面板版本提供，只读；要改请复制一份到自己的技能目录')}</span>
        </div>
        {deployed && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-accent-soft px-4 py-3">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="min-w-0 flex-1 text-body leading-relaxed">
              {t('这个技能还有一份部署在「设置 → 部署」，那份要覆盖部署一次才会更新。')}
            </span>
            <Button size="sm" variant="secondary" onClick={() => openSettings('deploy')}>
              {t('去部署')}
            </Button>
          </div>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-medium">{t('文件结构')}</h3>
            {rows.length > 0 && (
              <span className="text-footnote text-subtle">{t('另有 {n} 个文件', { n: countFiles(rows) })}</span>
            )}
          </div>
          <div className="flex flex-col gap-3 lg:flex-row">
            <Card padding="xs" className="flex min-w-0 flex-col gap-0.5 self-start lg:w-[240px] lg:shrink-0">
              {/* 主文件也列在树里：自带技能的内容只读，不存在「主文件在别处编辑」 */}
              <button
                type="button"
                onClick={() => open('')}
                aria-current={picked === '' && file ? true : undefined}
                title="SKILL.md"
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body',
                  picked === '' && file ? 'bg-sel text-fg' : 'text-muted hover:bg-sel/60',
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-accent-text" />
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
                      'flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-body',
                      picked === r.path ? 'bg-sel text-fg' : 'hover:bg-sel/60',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', isDir ? 'text-subtle' : 'text-accent-text')} />
                    <span className={cn('truncate', isDir ? 'text-muted' : 'font-mono')}>{entryName(r.path)}</span>
                  </button>
                )
              })}
              {item.tree?.truncated && (
                <p className="px-2 py-2 text-footnote text-subtle">{t('文件太多，只显示了前面一部分。')}</p>
              )}
            </Card>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {error ? (
                <p className="text-body text-warning">{t('读取失败：{error}', { error })}</p>
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
                  <span className="truncate font-mono text-footnote text-subtle">{file.path || 'SKILL.md'}</span>
                  <Card
                    as="pre"
                    padding="md"
                    className="max-h-[min(60vh,560px)] overflow-auto font-mono text-footnote leading-relaxed whitespace-pre-wrap"
                  >
                    {file.content}
                  </Card>
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
