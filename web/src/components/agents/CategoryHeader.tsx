import { useState } from 'react'
import { toast } from '@/lib/toast'
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Category } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'
import { InlineRename } from '@/components/ui/inline-rename'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { GroupHeader } from '@/components/layout/ListPane'

/** 列表里的分类标题：新建、重命名、删除（Agent 和工作流的分类共用） */
export function CategoryHeader({
  category,
  count,
  onAdd,
  compact,
  collapsed,
  onToggle,
}: {
  category: Category
  count: number
  onAdd: () => void
  /** 紧凑列表里标题也跟着收窄（和 GroupHeader 的紧凑档一致） */
  compact?: boolean
  /** 收起状态和开关：角色页的分类组可折叠，工作流页不传就不折 */
  collapsed?: boolean
  onToggle?: () => void
}) {
  const { setCategories, setAgents, setWorkflows } = useData()
  const isWf = category.scope === 'workflow'
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const rename = async (name: string) => {
    setEditing(false)
    const n = name.trim()
    if (!n || n === category.name) return
    try {
      const c = await api.renameCategory(category.id, n)
      setCategories((cs) => cs.map((x) => (x.id === c.id ? c : x)))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const remove = async () => {
    try {
      await api.deleteCategory(category.id)
      setCategories((cs) => cs.filter((x) => x.id !== category.id))
      setAgents((as) => as.map((a) => (a.categoryId === category.id ? { ...a, categoryId: '' } : a)))
      setWorkflows((ws) => ws.map((w) => (w.categoryId === category.id ? { ...w, categoryId: '' } : w)))
      toast.success(t('已删除分类「{name}」', { name: category.name }))
    } catch (e) {
      toast.error((e as Error).message)
    }
    setDeleting(false)
  }

  if (editing)
    return (
      <div className={cn('flex items-center px-2', compact ? 'h-8 pt-1' : 'h-9 pt-2')}>
        <InlineRename
          value={category.name}
          label={t('分类名称')}
          size="sm"
          onCommit={(v) => void rename(v)}
          onCancel={() => setEditing(false)}
          className="w-full"
        />
      </div>
    )

  return (
    <>
      <GroupHeader
        label={category.name}
        count={count}
        compact={compact}
        collapsed={collapsed}
        onToggle={onToggle}
        actions={
          <>
            <IconButton
              icon={Plus}
              size="sm"
              label={isWf ? t('在此分类新建工作流') : t('在此分类新建角色')}
              onClick={onAdd}
            />
            <Menu>
              <MenuTrigger asChild>
                <IconButton icon={MoreHorizontal} size="sm" label={t('分类操作')} />
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => setEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('重命名')}
                </MenuItem>
                <MenuItem danger onSelect={() => setDeleting(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('删除分类')}
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        }
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('删除分类「{name}」？', { name: category.name })}
        description={
          isWf ? t('分类里的工作流不会被删除，会移到「未分类」。') : t('分类里的角色不会被删除，会移到「未分类」。')
        }
        onConfirm={remove}
      />
    </>
  )
}
