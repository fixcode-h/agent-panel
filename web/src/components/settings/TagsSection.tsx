import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Plus, Trash2 } from 'lucide-react'
import { TAG_COLORS, type Tag } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Card } from '@/components/ui/card'
import { TAG_HEX, TagChip } from '@/components/tags/Tags'

/** 设置里的标签管理：Agent 和工作流共用一套标签，在这里新建、改名、换颜色、删除 */
export function TagsSection() {
  const { tags, setTags, agents, workflows, setAgents, setWorkflows } = useData()
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState<Tag | null>(null)

  const save = async (tag: Tag, patch: Partial<Tag>) => {
    const next = { ...tag, ...patch }
    setTags((ts) => ts.map((x) => (x.id === tag.id ? next : x)))
    try {
      const saved = await api.updateTag(tag.id, { name: next.name, color: next.color, description: next.description })
      setTags((ts) => ts.map((x) => (x.id === tag.id ? saved : x)))
    } catch (e) {
      toast.error((e as Error).message)
      setTags((ts) => ts.map((x) => (x.id === tag.id ? tag : x)))
    }
  }

  const add = async () => {
    const n = name.trim()
    if (!n) return
    try {
      const tag = await api.createTag({
        name: n,
        color: TAG_COLORS[(tags.length + 1) % TAG_COLORS.length],
        description: '',
      })
      setTags((ts) => [...ts, tag])
      setName('')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const remove = async (tag: Tag) => {
    try {
      await api.deleteTag(tag.id)
      setTags((ts) => ts.filter((x) => x.id !== tag.id))
      const drop = <T extends { tags: string[] }>(x: T) =>
        x.tags.includes(tag.id) ? { ...x, tags: x.tags.filter((id) => id !== tag.id) } : x
      setAgents((as) => as.map(drop))
      setWorkflows((ws) => ws.map(drop))
      toast.success(t('已删除标签「{name}」', { name: tag.name }))
    } catch (e) {
      toast.error((e as Error).message)
    }
    setDeleting(null)
  }

  const usage = (id: string) => ({
    agents: agents.filter((a) => a.tags.includes(id)).length,
    workflows: workflows.filter((w) => w.tags.includes(id)).length,
  })

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-muted">
        {t('标签是全局的，角色和工作流共用。列表上方可以按标签筛选，搜索时也会匹配标签名。')}
      </p>
      <div className="flex gap-2">
        <Input
          value={name}
          maxLength={20}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void add()
          }}
          placeholder={t('新标签名，例如：前端、常用、实验中')}
          className="h-9"
        />
        <Button onClick={() => void add()} disabled={!name.trim()}>
          <Plus className="h-4 w-4" />
          {t('新建')}
        </Button>
      </div>
      <Card className="flex flex-col divide-y">
        {tags.map((tag) => {
          const u = usage(tag.id)
          return (
            <div key={tag.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <TagChip tag={tag} className="shrink-0" />
              <TagName tag={tag} onSave={(n) => save(tag, { name: n })} />
              <div className="flex items-center gap-1" role="radiogroup" aria-label={t('颜色')}>
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={tag.color === c}
                    aria-label={c}
                    onClick={() => save(tag, { color: c })}
                    style={{ background: TAG_HEX[c] }}
                    className={cn(
                      'h-4 w-4 cursor-pointer rounded-full ring-offset-2 ring-offset-card transition',
                      tag.color === c ? 'ring-2 ring-fg/60' : 'opacity-60 hover:opacity-100',
                    )}
                  />
                ))}
              </div>
              <span className="ml-auto text-xs text-subtle">
                {t('{a} 个角色 · {w} 个工作流', { a: u.agents, w: u.workflows })}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('删除标签')}
                title={t('删除标签')}
                onClick={() => setDeleting(tag)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )
        })}
        {!tags.length && <p className="px-4 py-6 text-center text-[0.8125rem] text-subtle">{t('还没有标签')}</p>}
      </Card>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('删除标签「{name}」？', { name: deleting?.name ?? '' })}
        description={t('角色和工作流不会被删除，只是去掉这个标签。')}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  )
}

/** 标签名：失焦或回车时保存 */
function TagName({ tag, onSave }: { tag: Tag; onSave: (name: string) => void }) {
  const [v, setV] = useState(tag.name)
  const commit = () => {
    const n = v.trim()
    if (!n) return setV(tag.name)
    if (n !== tag.name) onSave(n)
  }
  return (
    <Input
      value={v}
      maxLength={20}
      aria-label={t('标签名')}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()}
      className="h-8 w-40 text-[0.8125rem]"
    />
  )
}
