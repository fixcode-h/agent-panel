import { useId } from 'react'
import { t } from '@shared/i18n'
import { everyLabel, TRIGGER_EVERY_OPTIONS, type ScheduleTrigger } from '@shared/schedule/trigger'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import { Input, Select } from '@/components/ui/input'

/**
 * 按事件触发的计划的条件字段：编辑弹窗和详情面板共用。
 * 只画「看什么、多久看一次」，触发方式本身（按时间 / 文件变了 / …）的分段选择由外面放，
 * 这样两边的版式（弹窗里宽、详情里窄）各自安排，字段和校验只有这一份。
 */
export function TriggerFields({
  trigger,
  projectId,
  onChange,
  compact = false,
}: {
  trigger: ScheduleTrigger
  /** 计划所在项目：空表示聊天，目录必须填绝对路径 */
  projectId: string
  onChange: (patch: Partial<ScheduleTrigger>) => void
  /** 详情面板里用：标签小一号、控件矮一点 */
  compact?: boolean
}) {
  const uid = useId()
  const h = compact ? 'h-8 text-body' : 'h-10'
  const label = compact ? 'text-caption font-semibold tracking-wide text-subtle' : 'text-body font-medium'
  const field = (id: string, text: string, control: React.ReactNode, hint?: string) => (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`${uid}-${id}`} className={label}>
        {text}
      </label>
      {control}
      {hint && <span className="text-xs text-subtle">{hint}</span>}
    </div>
  )
  const dirPlaceholder = projectId ? t('留空表示项目目录，也可以填相对路径') : t('绝对路径，例如 D:/Game/Content')
  // 当前值不在档上（手改过数据）也列出来，不让下拉框显示成空
  const everyOptions = [...new Set([...TRIGGER_EVERY_OPTIONS, trigger.everyMin])]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: everyLabel(n) }))

  return (
    <div className="flex flex-col gap-3">
      {trigger.kind === 'files' &&
        field(
          'path',
          t('要看的目录'),
          <Input
            id={`${uid}-path`}
            className={cn(h, 'font-mono')}
            value={trigger.path}
            placeholder={dirPlaceholder}
            onChange={(e) => onChange({ path: e.target.value })}
          />,
          t('目录里任何文件新增、修改、删除都算变化；.git 和 node_modules 不看。'),
        )}
      {trigger.kind === 'git' && (
        <>
          <div className={cn('grid gap-2.5', compact ? 'grid-cols-[1fr_2fr]' : 'sm:grid-cols-[1fr_2fr]')}>
            {field(
              'remote',
              t('远端'),
              <Input
                id={`${uid}-remote`}
                className={cn(h, 'font-mono')}
                value={trigger.remote}
                placeholder="origin"
                onChange={(e) => onChange({ remote: e.target.value })}
              />,
            )}
            {field(
              'branch',
              t('分支'),
              <Input
                id={`${uid}-branch`}
                className={cn(h, 'font-mono')}
                value={trigger.branch}
                placeholder="main"
                onChange={(e) => onChange({ branch: e.target.value })}
              />,
            )}
          </div>
          {field(
            'path',
            t('仓库目录'),
            <Input
              id={`${uid}-path`}
              className={cn(h, 'font-mono')}
              value={trigger.path}
              placeholder={dirPlaceholder}
              onChange={(e) => onChange({ path: e.target.value })}
            />,
          )}
        </>
      )}
      {trigger.kind === 'command' && (
        <>
          {field(
            'command',
            t('检查命令'),
            <Input
              id={`${uid}-command`}
              className={cn(h, 'font-mono')}
              value={trigger.command}
              placeholder={t('例如：npm test，或查 CI 状态的脚本')}
              onChange={(e) => onChange({ command: e.target.value })}
            />,
            t('按设置里选的命令行环境执行，最多跑 10 分钟；输出的最后几行会附给 Agent。'),
          )}
          {field(
            'path',
            t('在哪个目录跑'),
            <Input
              id={`${uid}-path`}
              className={cn(h, 'font-mono')}
              value={trigger.path}
              placeholder={dirPlaceholder}
              onChange={(e) => onChange({ path: e.target.value })}
            />,
          )}
          <Checkbox
            checked={trigger.onlyFailure}
            onChange={(v) => onChange({ onlyFailure: v })}
            label={t('只在变成失败时新建对话')}
            hint={t('不勾时退出码一变就新建，修好了也算')}
          />
        </>
      )}
      {field(
        'every',
        t('多久检查一次'),
        <Select
          id={`${uid}-every`}
          size={compact ? 'sm' : undefined}
          className={compact ? undefined : 'h-10 w-40'}
          value={String(trigger.everyMin)}
          options={everyOptions}
          onChange={(e) => onChange({ everyMin: Number(e.target.value) })}
        />,
        t('面板开着时才检查。第一次只记下现状，之后有变化才新建对话，变了什么会附在对话内容后面。'),
      )}
    </div>
  )
}
