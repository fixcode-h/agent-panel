import { RotateCcw } from 'lucide-react'
import { type Agent, type AgentInput, type AgentMount } from '@shared/schema'
import { roleKind } from '@shared/agent-role'
import { listableAgents } from '@shared/builtin/core'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FormSection, Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { MountCard, MountPicker } from './MountCard'

/**
 * 「能力」页：角色分层（见 docs/openspec/changes/role-composition-and-dispatch）。
 * 基本角色写「什么时候用」和允许的用法；高级角色挂载基本角色、定每个能力怎么用，以及父对话能不能就地微改动。
 * locked（内置角色）时角色层和基本角色的用法由面板维护；挂载照样能加、删、改说明，改了就由用户接管（mountsCustom），
 * defaults 是内置定义在本机该挂的那份，用来「恢复默认挂载」
 */
export function CapabilityFields({
  draft,
  self,
  agents,
  locked,
  defaults,
  set,
}: {
  draft: AgentInput
  self: Agent
  agents: Agent[]
  locked: boolean
  defaults?: AgentMount[]
  set: <K extends keyof AgentInput>(key: K, value: AgentInput[K]) => void
}) {
  const kind = roleKind(draft)
  // 能挂的：启用的基本角色，不是自己、还没挂（「子任务」是兜底角色，不作为可选能力）
  const mountable = listableAgents(agents).filter(
    (a) => a.id !== self.id && roleKind(a) === 'basic' && !draft.mounts.some((m) => m.agentId === a.id),
  )
  // 内置高级角色改了挂载就算接管：之后启动同步不再按内置定义改写它的挂载（AgentInput.mountsCustom）
  const setMounts = (mounts: AgentMount[]) => {
    set('mounts', mounts)
    if (locked) set('mountsCustom', true)
  }

  return (
    <>
      <FormSection title={t('角色层')}>
        <p className="-mt-2 text-xs leading-relaxed text-subtle">
          {t(
            '基本角色专注一个能力，可以派成子任务、当工作流节点，也可以被高级角色挂载；高级角色是父对话、子对话的负责人，挂载几个基本角色，自己决定每件事就地做还是派出去。',
          )}
        </p>
        {locked ? (
          <p className="text-body">{kind === 'advanced' ? t('高级角色') : t('基本角色')}</p>
        ) : (
          <Segmented
            label={t('角色层')}
            value={kind}
            onChange={(v) => set('kind', v)}
            options={[
              { id: 'basic', label: t('基本角色') },
              { id: 'advanced', label: t('高级角色') },
            ]}
          />
        )}
      </FormSection>

      {kind === 'basic' && !locked && (
        <FormSection title={t('被使用时')}>
          <Field
            label={t('什么时候用')}
            hint={t('一句话，会写进挂载它的高级角色的能力索引，模型按它决定用不用；不写用简介')}
          >
            <Input
              value={draft.when}
              onChange={(e) => set('when', e.target.value)}
              placeholder={t('例如：改完并跑过快速检查后，独立看一遍改动')}
            />
          </Field>
          <Checkbox
            checked={draft.modes.includes('inline')}
            onChange={(v) =>
              set(
                'modes',
                v ? [...new Set([...draft.modes, 'inline' as const])] : draft.modes.filter((m) => m !== 'inline'),
              )
            }
            label={t('允许就地用')}
            hint={t('高级角色可以把它的做法加载进当前对话自己做，不用冷启动一个子任务')}
          />
          <Checkbox
            checked={draft.modes.includes('subtask')}
            onChange={(v) =>
              set(
                'modes',
                v ? [...new Set([...draft.modes, 'subtask' as const])] : draft.modes.filter((m) => m !== 'subtask'),
              )
            }
            label={t('允许派成子任务')}
          />
          <Checkbox
            checked={draft.independent}
            onChange={(v) => set('independent', v)}
            label={t('必须独立执行')}
            hint={t('结论要不受执行者思路影响（例如评审）：只能派成子任务，不能就地用')}
          />
        </FormSection>
      )}
      {kind === 'basic' && locked && (draft.when || draft.independent) && (
        <FormSection title={t('被使用时')}>
          {draft.when && <p className="text-body leading-relaxed text-muted">{draft.when}</p>}
          {draft.independent && <p className="text-xs text-subtle">{t('必须独立执行：只能派成子任务，不能就地用')}</p>}
        </FormSection>
      )}

      {kind === 'advanced' && (
        <FormSection title={t('挂载的能力')}>
          <p className="-mt-2 text-xs leading-relaxed text-subtle">
            {t(
              '提示词里只放每个能力的一行索引，用到时再加载全文。「就地用」在当前对话里按它的做法做；「派成子任务」冷启动一个子任务；「自动判断」量小就地、量大或要独立视角就派出；「转交父对话」在子对话里点名时交给父对话创建。',
            )}
          </p>
          {locked && draft.mountsCustom && (
            <div className="flex items-center gap-2 rounded-lg bg-panel/60 px-3 py-1.5 text-xs text-muted">
              <span className="min-w-0 flex-1">{t('挂载已按你的调整保存，不再跟着内置定义更新')}</span>
              {defaults && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    set('mounts', defaults)
                    set('mountsCustom', false)
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('恢复默认挂载')}
                </Button>
              )}
            </div>
          )}
          {draft.mounts.map((m, i) => (
            <MountCard
              key={m.agentId}
              mount={m}
              cap={agents.find((a) => a.id === m.agentId)}
              onChange={(patch) => setMounts(draft.mounts.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
              onRemove={() => setMounts(draft.mounts.filter((_, j) => j !== i))}
            />
          ))}
          <MountPicker
            options={mountable}
            onPick={(agentId) =>
              setMounts([...draft.mounts, { agentId, mode: 'auto', preload: false, rule: '', params: {} }])
            }
          />
          {!draft.mounts.length && (
            <p className="text-xs text-subtle">{t('还没有挂载能力：这个高级角色只按自己的角色设定做事')}</p>
          )}
        </FormSection>
      )}

      {kind === 'advanced' && (
        <FormSection title={t('调度')}>
          <Checkbox
            checked={draft.inlineEdit === 'tiny'}
            onChange={(v) => set('inlineEdit', v ? 'tiny' : 'off')}
            label={t('父对话可以就地微改动')}
            hint={t(
              '当这个角色是项目的父对话时：改什么已经清楚、不用排查，最多 2 个文件、20 行以内（文案、配置值、一两行文档）可以自己改完提交，不开子对话。面板会拦下子对话正在合回、文件被子对话占用的情况，改完核对是否越界。',
            )}
          />
        </FormSection>
      )}
    </>
  )
}
