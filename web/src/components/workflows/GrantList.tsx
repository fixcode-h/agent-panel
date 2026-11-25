import { ShieldCheck, X } from 'lucide-react'
import type { WorkflowGrant } from '@shared/schema'
import { t } from '@shared/i18n'
import { IconButton } from '@/components/ui/icon-button'

/**
 * 自带授权的列表：工作流的 grants（WorkflowRunSettings）和节点的 grants（流程图属性栏）共用。
 * 只能删不能加：加哪些由工作流的作者（内置模板、插件）定，用户复制一份改的时候可以去掉不想自动放行的
 */
export function GrantList({
  grants,
  hint,
  onChange,
}: {
  grants: WorkflowGrant[]
  hint: string
  onChange: (next: WorkflowGrant[]) => void
}) {
  if (!grants.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{t('自带的授权')}</span>
      <p className="text-xs leading-relaxed text-subtle">{hint}</p>
      <ul className="flex flex-col gap-1">
        {grants.map((g) => (
          <li key={g.rule} className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
            {/* 说法和规则键上下两行：节点属性栏窄，并排时说法被挤得只剩几个字 */}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-fg">{g.label || g.rule}</span>
              {g.label && <code className="truncate font-mono text-footnote text-subtle">{g.rule}</code>}
            </span>
            <IconButton
              icon={X}
              size="xs"
              label={t('去掉这条授权')}
              onClick={() => onChange(grants.filter((x) => x.rule !== g.rule))}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
