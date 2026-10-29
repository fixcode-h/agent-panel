import { Plus, X } from 'lucide-react'
import { type Agent, type AgentMount } from '@shared/schema'
import { canInline, canSubtask, mountMode } from '@shared/agent-role'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input, Select } from '@/components/ui/input'
import { AgentAvatar } from './AgentAvatar'

/** 挂载用法在界面上的说法 */
const MODE_LABEL: Record<AgentMount['mode'], string> = {
  auto: t('自动判断'),
  inline: t('就地用'),
  subtask: t('派成子任务'),
  parent: t('转交父对话'),
}

/**
 * 高级角色挂载的一个能力：用法、说明（rule，进能力索引）、常驻加载、移除。
 * 内置高级角色和自定义的一样能改：默认挂的也能改说明、移除（用户 2026-10-29 定的）
 */
export function MountCard({
  mount,
  cap,
  onChange,
  onRemove,
}: {
  mount: AgentMount
  /** 挂的那个基本角色；找不到说明已被删掉 */
  cap: Agent | undefined
  onChange: (patch: Partial<AgentMount>) => void
  onRemove: () => void
}) {
  // 能力自己不允许的用法标出来：选了也会被收紧（mountMode）
  const allowed = (mode: AgentMount['mode']) =>
    !cap || mountMode(mode, cap) === mode || (mode === 'auto' && canInline(cap) && canSubtask(cap))
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-card p-3 shadow-card">
      <div className="flex items-center gap-2">
        {cap ? <AgentAvatar icon={cap.icon} cli={cap.cli} size="xs" /> : null}
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">{cap?.name ?? t('（角色已删除）')}</span>
        <Select
          aria-label={t('用法')}
          value={mount.mode}
          onChange={(e) => onChange({ mode: e.target.value as AgentMount['mode'] })}
          options={(Object.keys(MODE_LABEL) as AgentMount['mode'][]).map((id) => ({
            value: id,
            label: allowed(id) ? MODE_LABEL[id] : t('{label}（这个能力不支持）', { label: MODE_LABEL[id] }),
          }))}
          className="w-[180px]"
        />
        <Button variant="ghost" size="icon" aria-label={t('移除')} title={t('移除')} onClick={onRemove}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {cap && (cap.when || cap.description) && (
        <p className="text-[0.6875rem] leading-relaxed text-subtle">{cap.when || cap.description}</p>
      )}
      <Input
        aria-label={t('挂载说明')}
        value={mount.rule}
        onChange={(e) => onChange({ rule: e.target.value })}
        placeholder={t('规则（可选）：什么时候就地、什么时候派出')}
      />
      <Checkbox
        checked={mount.preload}
        onChange={(v) => onChange({ preload: v })}
        label={t('常驻加载')}
        hint={t('就地用时把它的做法直接放进提示词（主能力用），不用每次再加载')}
      />
    </div>
  )
}

/** 再挂一个基本角色：内置的、自定义的都能挂 */
export function MountPicker({ options, onPick }: { options: Agent[]; onPick: (agentId: string) => void }) {
  if (!options.length) return null
  return (
    <div className="flex items-center gap-2">
      <Select
        aria-label={t('挂载能力')}
        value=""
        onChange={(e) => e.target.value && onPick(e.target.value)}
        placeholder={t('挂载一个基本角色…')}
        options={options.map((a) => ({ value: a.id, label: a.name }))}
        className="max-w-[320px]"
      />
      <Plus className="h-3.5 w-3.5 text-subtle" />
    </div>
  )
}
