import { useState } from 'react'
import { toast } from 'sonner'
import { Plus, Square, X } from 'lucide-react'
import type { Task, TaskRule } from '@shared/schema'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FormSection, Input, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { ChatModelPicker, useChatRun, type ChatRun } from './ChatModelPicker'
import { t } from '@shared/i18n'

/**
 * 父对话的设置：参考 Claude Projects 的项目设置，管这个对话的目标、全局规则和名下的子对话。
 * 目标和规则每一轮都交给父对话和子对话；子对话的 CLI / 模型只对这个对话生效，不改角色和全局设置。
 */
export function ConversationSettingsDialog({
  task,
  open,
  onOpenChange,
  onSaved,
}: {
  task: Task
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (t: Task) => void
}) {
  const [title, setTitle] = useState(task.title)
  const [goal, setGoal] = useState(task.goal)
  const [rules, setRules] = useState<TaskRule[]>(task.rules)
  const [rule, setRule] = useState('')
  const [custom, setCustom] = useState(!!task.childRun)
  const [run, setRun] = useState<ChatRun>(task.childRun ?? { cli: '', model: '', effort: '' })
  // 存下实际的 CLI / 模型 / 强度：空值是「默认」，之后改了默认 CLI 子对话也不会悄悄跟着变
  const resolved = useChatRun(run).run
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)

  const addRule = () => {
    const text = rule.trim()
    if (!text) return
    setRules((rs) => [...rs, { id: crypto.randomUUID(), text: text.slice(0, 2000), at: new Date().toISOString() }])
    setRule('')
  }

  const save = async () => {
    if (!title.trim()) return
    setBusy(true)
    try {
      const saved = await api.updateConversation(task.id, {
        title: title.trim(),
        goal,
        rules,
        childRun: custom ? resolved : null,
      })
      onSaved(saved)
      onOpenChange(false)
      toast.success(t('已保存对话设置'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stopAll = async () => {
    setStopping(true)
    try {
      const r = await api.stopChildren(task.id)
      toast.success(r.stopped ? t('已停止 {n} 个子对话', { n: r.stopped }) : t('没有正在运行的子对话'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setStopping(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('对话设置')}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button onClick={save} disabled={busy || !title.trim()}>
            {t('保存')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-7 px-5 py-5">
        <FormSection title={t('基本信息')}>
          <Field label={t('名称')} error={title.trim() ? undefined : t('名称不能为空')}>
            <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field
            label={t('目标')}
            hint={t('这个对话最终要做成什么。父对话和它的子对话每一轮都看得到，判断要不要做、做到哪一步时以它为准。')}
          >
            <Textarea
              value={goal}
              maxLength={4000}
              rows={3}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t('例如：商品详情页支持到货通知，上线前补齐单元测试')}
            />
          </Field>
        </FormSection>

        <FormSection title={t('全局规则')}>
          <p className="-mt-2 text-xs leading-relaxed text-subtle">
            {t(
              '所有子对话和它们的工作流节点都必须遵守，只对这个对话有效，不写进 AGENTS.md。对话里输入「/rule 内容」也能发布。',
            )}
          </p>
          {rules.length > 0 && (
            <ol className="flex flex-col gap-1.5">
              {rules.map((r, i) => (
                <li key={r.id} className="flex items-start gap-2 rounded-lg border bg-field px-3 py-2 text-[0.8125rem]">
                  <span className="mt-px shrink-0 font-mono text-xs text-subtle tabular-nums">{i + 1}.</span>
                  <span className="min-w-0 flex-1 leading-relaxed break-words whitespace-pre-wrap">{r.text}</span>
                  <button
                    type="button"
                    aria-label={t('删除规则')}
                    title={t('删除规则')}
                    onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))}
                    className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-sel hover:text-fg"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="flex gap-2">
            <Input
              value={rule}
              aria-label={t('新规则')}
              onChange={(e) => setRule(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  addRule()
                }
              }}
              placeholder={t('例如：不要改 package.json')}
            />
            <Button variant="secondary" onClick={addRule} disabled={!rule.trim()}>
              <Plus className="h-4 w-4" />
              {t('添加')}
            </Button>
          </div>
        </FormSection>

        <FormSection title={t('子对话')}>
          <Checkbox
            checked={custom}
            onChange={setCustom}
            label={t('子对话用指定的 Agent 和模型')}
            hint={t('不勾选时按「执行」角色自己的配置。只对这个对话的子对话生效，下一轮开始时用上。')}
          />
          {custom && (
            <div className="-mt-1 flex flex-wrap items-center gap-1 rounded-lg border bg-field px-1.5 py-1">
              <ChatModelPicker value={run} onChange={setRun} />
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button variant="danger-outline" size="sm" onClick={stopAll} disabled={stopping}>
              <Square className="h-3.5 w-3.5" />
              {t('停止全部子对话')}
            </Button>
            <span className="text-xs text-subtle">{t('正在执行的停下来，输出和状态都保留，之后可以接着说。')}</span>
          </div>
        </FormSection>
      </div>
    </Modal>
  )
}
