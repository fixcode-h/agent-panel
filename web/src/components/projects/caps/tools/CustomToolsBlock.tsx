import { useState } from 'react'
import { Copy, Hammer, MoreHorizontal, MoveRight, Pencil, Play, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import type { ToolEntry, ToolScope } from '@shared/custom-tools/schema'
import { t } from '@shared/i18n'
import { EffectBadge } from '@/components/ui/tool-run-result'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { IconButton } from '@/components/ui/icon-button'
import { openMenuAt } from '@/components/ui/item-menu'
import { CapabilityBlockHeader, CapabilityItem, CapabilityItemList } from '@/components/ui/capability-item'
import type { CustomTools } from './use-custom-tools'
import { ToolEditor } from './ToolEditor'

/** 搜索命中：名字、id、说明、标签 */
export const toolHit = (e: ToolEntry, q: string) => {
  const s = q.trim().toLowerCase()
  if (!s) return true
  const x = e.tool
  return [e.file, x?.id, x?.name, x?.summary, x?.useWhen, ...(x?.tags ?? [])].join(' ').toLowerCase().includes(s)
}

/**
 * 「技能与 MCP」页的「工具」块（ADR 0082）：项目的（文档根/AgentPanel/Tools，团队共用）和全局的（数据目录/tools，只在本机）分两块列。
 * 点一行打开编辑抽屉（含试运行）；行尾菜单：试运行、复制 / 移到另一边、删除。新工具在对话里用 /createtool 让 Agent 做
 */
export function CustomToolsBlock({ ct, q, inProject }: { ct: CustomTools; q: string; inProject: boolean }) {
  const [open, setOpen] = useState<{ scope: ToolScope; id: string; tab?: 'try' }>()
  const entries = ct.data?.entries ?? []
  const editing = open && entries.find((e) => e.scope === open.scope && e.tool?.id === open.id)
  const block = (scope: ToolScope) => {
    const list = entries.filter((e) => e.scope === scope && toolHit(e, q))
    const all = entries.filter((e) => e.scope === scope).length
    const dir = scope === 'project' ? ct.data?.projectDir : ct.data?.globalDir
    return (
      <section key={scope} className="flex flex-col gap-3">
        <CapabilityBlockHeader
          title={scope === 'project' ? t('项目的工具') : t('全局的工具')}
          meta={
            ct.data
              ? scope === 'project'
                ? t('{n} 个 · 跟着文档走，团队共用', { n: all })
                : t('{n} 个 · 只在本机，所有项目可用', { n: all })
              : t('正在读取…')
          }
          action={
            scope === 'project' ? (
              <IconButton icon={RefreshCw} size="sm" label={t('重新读取')} onClick={ct.reload} />
            ) : undefined
          }
        />
        {list.length ? (
          <CapabilityItemList footer={dir && <span className="font-mono text-caption text-subtle">{dir}</span>}>
            {list.map((e) => (
              <ToolRow
                key={e.file}
                e={e}
                inProject={inProject}
                onOpen={(tab) => e.tool && setOpen({ scope, id: e.tool.id, tab })}
                ct={ct}
              />
            ))}
          </CapabilityItemList>
        ) : (
          <EmptyPanel size="md">
            {q.trim()
              ? t('没有符合筛选的工具。')
              : scope === 'project'
                ? t(
                    '还没有项目工具。在对话里输入 /createtool <要做的事>，Agent 会读文档和脚本做成工具，存的时候选「项目」。',
                  )
                : t('还没有全局工具。/createtool 做出来的工具存的时候选「全局」就会在这里。')}
          </EmptyPanel>
        )}
      </section>
    )
  }
  return (
    <>
      {ct.error && <p className="text-footnote break-all text-danger">{ct.error}</p>}
      {inProject && block('project')}
      {block('global')}
      {editing?.tool && (
        <ToolEditor
          key={`${editing.scope}:${editing.tool.id}`}
          entry={editing}
          tool={editing.tool}
          ct={ct}
          startTab={open?.tab}
          onClose={() => setOpen(undefined)}
        />
      )}
    </>
  )
}

function ToolRow({
  e,
  inProject,
  onOpen,
  ct,
}: {
  e: ToolEntry
  inProject: boolean
  onOpen: (tab?: 'try') => void
  ct: CustomTools
}) {
  const x = e.tool
  if (!x)
    return (
      <CapabilityItem
        icon={TriangleAlert}
        name={e.file.split(/[\\/]/).pop() ?? e.file}
        kind={t('读不进来')}
        description={e.error}
        where={e.file}
      />
    )
  const other: ToolScope = e.scope === 'project' ? 'global' : 'project'
  const otherName = other === 'project' ? t('项目') : t('全局')
  const menu = (el: HTMLElement) =>
    openMenuAt(el, [
      { label: t('编辑'), icon: Pencil, onClick: () => onOpen() },
      { label: t('试运行'), icon: Play, onClick: () => onOpen('try') },
      'sep',
      (other === 'global' || inProject) && {
        label: t('复制到{where}', { where: otherName }),
        icon: Copy,
        onClick: () => void ct.copy(e.scope, x.id, other, false),
      },
      (other === 'global' || inProject) && {
        label: t('移到{where}', { where: otherName }),
        icon: MoveRight,
        onClick: () => void ct.copy(e.scope, x.id, other, true),
      },
      'sep',
      { label: t('删除'), icon: Trash2, danger: true, onClick: () => void ct.remove(e.scope, x.id) },
    ])
  return (
    <div
      role="button"
      tabIndex={0}
      className="group cursor-pointer rounded-lg hover:bg-hover"
      onClick={() => onOpen()}
      onKeyDown={(ev) => ev.key === 'Enter' && onOpen()}
      onContextMenu={(ev) => {
        ev.preventDefault()
        menu(ev.currentTarget)
      }}
    >
      <CapabilityItem
        icon={Hammer}
        name={x.name}
        kind={x.id}
        description={x.useWhen || x.summary}
        where={`v${x.version}${e.last ? ` · ${e.last.ok ? t('上次成功') : t('上次失败')}` : ''}`}
        whereNote={e.shadowed ? t('被项目里同名的工具盖住了') : undefined}
        muted={e.shadowed}
        trailing={
          <>
            <EffectBadge effect={x.effect} />
            <IconButton
              icon={MoreHorizontal}
              size="xs"
              label={t('更多操作')}
              onClick={(ev) => {
                ev.stopPropagation()
                menu(ev.currentTarget)
              }}
            />
          </>
        }
      />
    </div>
  )
}
