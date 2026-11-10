import { useState } from 'react'
import { ChevronDown, Loader2, Shuffle } from 'lucide-react'
import { t } from '@shared/i18n'
import { defaultAgent, type Task } from '@shared/schema'
import { agentRun, defaultSettings } from '@shared/settings'
import { retryModelChoices, withTaskModel } from '@shared/task-run'
import { useData } from '@/lib/data'
import { useCliDef } from '@/lib/cli-models'
import { modelEfforts } from '@/lib/cli-style'
import { useModelName } from '@/lib/model-name'
import { retryWithModel } from '@/lib/api-retry'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'

/**
 * 失败后的「换个模型重试」（分析稿 A7）：这一轮因为模型请求失败、CLI 报错停下时，以前只能自己换模型再手动重发。
 * 点开列出这个对话当前 CLI 下能用的其他模型（和输入框里的模型下拉同一个来源：useCliDef 读到的列表），
 * 选了就把这个对话的模型改成它，并把失败的那一轮原样重发（和旁边的「重试」同一条路，见 lib/api-retry）。
 * 是用户自己点的，面板不会自己换模型重试（AGENTS.md：错误如实显示、不悄悄重试）。
 * 只给对话用：工作流节点的模型跟着节点的角色和档位，不在这里换
 */
export function RetryModelMenu({
  task,
  agent,
  disabled,
  onDone,
}: {
  task: Pick<Task, 'id' | 'mode' | 'agentId' | 'cli' | 'model' | 'effort' | 'sessionCli' | 'modelOverride'>
  /** 对话的角色；不用角色的对话不传 */
  agent?: { id: string; cli: string; model: string; effort: string }
  disabled?: boolean
  onDone: (task: Task) => void
}) {
  const { settings } = useData()
  const [busy, setBusy] = useState(false)
  const modelName = useModelName()
  // 和服务端执行时同一个算法（withTaskModel + agentRun）：列出来的「当前模型」才和实际跑的那个对得上
  const run = agentRun(withTaskModel(agent ?? { ...defaultAgent(), id: '' }, task), settings ?? defaultSettings())
  const def = useCliDef(run.cli || undefined)
  // 没指定模型时 CLI 用它自己的默认模型：那一个也算「正在用的」，不列出来
  const current = run.model || def?.models.find((m) => m.isDefault)?.id || ''
  const choices = retryModelChoices(def?.models ?? [], current)

  const pick = async (model: string) => {
    if (!def) return
    setBusy(true)
    try {
      onDone(await retryWithModel(task, { cli: def.id, model, efforts: modelEfforts(def, model).map((e) => e.id) }))
    } catch (e) {
      // 重发没发出去：原因照实显示，对话还停在失败上，可以再点
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-lg"
          disabled={disabled || busy || !choices.length}
          title={
            choices.length ? t('把这个对话换成别的模型，重新执行最后一条要求') : t('这个 Agent 下没有别的模型可换')
          }
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shuffle className="h-3.5 w-3.5" />}
          {t('换个模型重试')}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </MenuTrigger>
      <MenuContent align="start" className="max-w-[min(420px,calc(100vw-24px))]">
        <p className="px-2.5 pt-1.5 pb-1 text-caption text-subtle">
          {t('{cli} 的其他模型（现在是 {model}）', {
            cli: def?.name ?? '',
            model: current ? modelName(current, def?.id) : t('默认模型'),
          })}
        </p>
        <div className="max-h-72 overflow-y-auto">
          {choices.map((m) => (
            <MenuItem key={m.id} className="py-1.5" onSelect={() => void pick(m.id)}>
              <span className="min-w-0 flex-1 truncate font-mono text-footnote">{modelName(m.id, def?.id)}</span>
              {m.label && <span className="max-w-[45%] shrink-0 truncate text-caption text-subtle">{m.label}</span>}
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}
