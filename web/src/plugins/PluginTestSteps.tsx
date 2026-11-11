import { t } from '@shared/i18n'
import { fillConfig, pluginItemId } from '@shared/plugins/contrib'
import { appliesToText, scopeText } from '@shared/test-steps'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { pluginIcon } from './icon'
import { usePlugins } from './registry'

/**
 * 项目设置 →「测试步骤」下面的「插件带的测试步骤」（插件接口 3）：开着的插件清单里写的步骤，
 * 接在项目自己的步骤后面一起按改动筛、一起交给 Agent。这里只能按项目关掉某一条（存在 pluginStepsOff），
 * 命令改不了——要改就在插件参数里改路径，或者关掉它自己写一条
 */
export function PluginTestSteps({ off, onChange }: { off: string[]; onChange: (v: string[]) => void }) {
  const { rows } = usePlugins()
  const list = rows
    .filter((r) => r.enabled && !r.error)
    .flatMap((r) =>
      (r.manifest.testSteps ?? []).map((s) => ({ row: r, step: s, id: pluginItemId(r.manifest.id, s.id) })),
    )
  if (!list.length) return null
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs leading-relaxed text-subtle">
        {t(
          '插件带的测试步骤：接在上面的步骤后面，同样按适用改动筛。关掉插件后自动撤掉；只想在这个项目不用就关掉开关。',
        )}
      </span>
      <ul className="flex flex-col gap-2">
        {list.map(({ row, step, id }) => {
          const on = !off.includes(id)
          const Icon = pluginIcon(row.manifest.icon)
          return (
            <li key={id} className={cn('flex items-start gap-3 rounded-xl bg-sel/40 p-3', !on && 'opacity-60')}>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-1.5 text-body font-medium">
                  {t(step.name)}
                  <Badge>
                    <Icon className="h-3 w-3" />
                    {row.manifest.name}
                  </Badge>
                  <Badge>{scopeText(step)}</Badge>
                </span>
                <code className="truncate font-mono text-xs text-muted" title={step.command}>
                  {fillConfig(step.command, row.config)}
                </code>
                <span className="text-xs text-subtle">
                  {t('适用改动：{globs}', { globs: appliesToText(step) })}
                  {!!step.detect.length &&
                    ` · ${t('只在项目根有 {files} 时生效', { files: step.detect.join(t('、')) })}`}
                </span>
              </div>
              <Switch
                checked={on}
                onCheckedChange={(v) => onChange(v ? off.filter((x) => x !== id) : [...off, id])}
                aria-label={t('在这个项目用「{name}」', { name: t(step.name) })}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
