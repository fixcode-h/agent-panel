import { useMemo } from 'react'
import { Download, Loader2, Package, RefreshCw } from 'lucide-react'
import { BUNDLED_CATEGORIES, type BundledSkill } from '@shared/library'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { GroupHeader, ListEmpty, ListGroup, ListItem } from '@/components/layout/ListPane'
import { BUNDLED_INSTALL_ALL, BUNDLED_STATUS_LABEL, BUNDLED_UPDATE_ALL } from '@/lib/use-bundled-skills'

/** 分类的显示名：没在 BUNDLED_CATEGORIES 里的分类直接用目录名 */
export const categoryLabel = (id: string) => BUNDLED_CATEGORIES.find((c) => c.id === id)?.label ?? id

/**
 * 面板自带的 Skill 列表（左栏）：按分类分组，点一项右边看详情。
 * 这些技能统一装在 ~/.agents/skills，所有 Agent 共用；源是仓库 skills/ 下随版本发布的那一份。
 */
export function BundledSkills({
  query,
  picked,
  onPick,
  items,
  error,
}: {
  query: string
  /** 当前选中的技能名（地址里的 id） */
  picked?: string
  onPick: (name: string) => void
  /** 列表由页面统一拿（详情页也要用同一份），这里只负责画 */
  items: BundledSkill[] | null
  error: string
}) {
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (items ?? []).filter((i) => !q || `${i.name} ${i.description}`.toLowerCase().includes(q))
    const cats = [...BUNDLED_CATEGORIES, ...[...new Set(list.map((i) => i.category))].map((id) => ({ id, label: id }))]
    return cats
      .filter((c, i) => cats.findIndex((x) => x.id === c.id) === i)
      .map((c) => ({ ...c, items: list.filter((i) => i.category === c.id) }))
      .filter((g) => g.items.length)
  }, [items, query])

  if (error) return <p className="px-2 py-6 text-[0.8125rem] text-warning">{t('读取失败：{error}', { error })}</p>
  if (!items) return <p className="px-2 py-6 text-[0.8125rem] text-subtle">{t('读取中…')}</p>
  if (!groups.length)
    return <ListEmpty>{query ? t('没有符合的{kind}。', { kind: 'Skill' }) : t('还没有自带 Skill。')}</ListEmpty>
  return (
    <>
      {groups.map((g) => (
        <ListGroup key={g.id} header={<GroupHeader label={g.label} count={g.items.length} />}>
          {g.items.map((i) => (
            <ListItem
              key={i.name}
              selected={picked === i.name}
              onClick={() => onPick(i.name)}
              leading={<Package className="h-4 w-4 shrink-0 text-accent" />}
              title={
                <>
                  {i.name}
                  {i.files > 0 && (
                    <span className="ml-2 font-sans text-[0.71875rem] font-normal text-subtle">
                      {t('另有 {n} 个文件', { n: i.files })}
                    </span>
                  )}
                </>
              }
              subtitle={i.description || t('没有说明')}
              monoSubtitle={false}
              trailing={
                <span className="shrink-0 text-[0.71875rem] text-subtle">{BUNDLED_STATUS_LABEL[i.status.shared]}</span>
              }
            />
          ))}
        </ListGroup>
      ))}
    </>
  )
}

/**
 * 左栏底部：装到哪、两个批量操作。
 * 详情页里也有单项的安装 / 更新，这里只管「一次处理全部」。
 */
export function BundledBulkBar({
  items,
  busy,
  onInstall,
}: {
  items: BundledSkill[] | null
  busy: string
  /** 批量安装：key 是 BUNDLED_INSTALL_ALL 或 BUNDLED_UPDATE_ALL */
  onInstall: (names: string[], key: string, overwrite: boolean) => void
}) {
  const outdated = (items ?? []).filter((i) => i.status.shared === 'changed')
  const missing = (items ?? []).some((i) => i.status.shared === 'missing')
  // 一次只跑一个批量操作（都在写 ~/.agents/skills）：另一个按钮变灰时说明为什么点不了
  // 只在「别的操作在跑」时提示——自己正在跑的时候按钮是转圈的，不需要再解释
  const waitTitle = (key: string) => (busy && busy !== key ? t('等当前操作完成') : undefined)
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-x-1.5 text-[0.71875rem] text-subtle">
        {t('装到')}
        <span className="font-mono">~/.agents/skills</span>
        {t('，所有 Agent 共用')}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          className="flex-1"
          disabled={!!busy || !missing}
          onClick={() =>
            onInstall(
              (items ?? []).map((i) => i.name),
              BUNDLED_INSTALL_ALL,
              false,
            )
          }
          title={waitTitle(BUNDLED_INSTALL_ALL) ?? t('只装没有的，已经装了的不动')}
        >
          {busy === BUNDLED_INSTALL_ALL ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t('安装全部未装的')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="flex-1"
          disabled={!!busy || !outdated.length}
          // 只传改过的那些，按 overwrite 换回自带版本；已经一样的不动
          onClick={() =>
            onInstall(
              outdated.map((i) => i.name),
              BUNDLED_UPDATE_ALL,
              true,
            )
          }
          title={waitTitle(BUNDLED_UPDATE_ALL) ?? t('把和自带不一样的全部换回自带版本（你改过的内容会丢掉）')}
        >
          {busy === BUNDLED_UPDATE_ALL ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('更新全部')}
        </Button>
      </div>
    </div>
  )
}
