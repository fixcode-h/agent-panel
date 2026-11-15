import { RULE_GROUPS, type RuleGroup, type StyleRule } from '@shared/style-types'
import { Textarea } from '@/components/ui/input'
import { t } from '@shared/i18n'

/** 约束组的名字：静态写出来，文案检查才认得 */
export const ruleGroupLabel = (g: RuleGroup) =>
  ({
    shape: t('造型'),
    proportion: t('比例'),
    topology: t('拓扑'),
    detail: t('细节'),
    structure: t('结构'),
    material: t('材质与着色'),
    outline: t('描边'),
    check: t('验收'),
    avoid: t('避免'),
  })[g]

/**
 * 3D 模型风格的约束要点：按约束组分开，一组一个文本框、一行一条（交给 Agent 时也是一条一行）。
 * 内置风格只读、只列有内容的组；自己的风格九组都列出来，空着的组就是没有要求（按通用做）
 */
export function StyleRulesEditor({
  rules,
  readOnly,
  onChange,
}: {
  rules: StyleRule[]
  readOnly?: boolean
  onChange?: (rules: StyleRule[]) => void
}) {
  const groups = RULE_GROUPS.filter((g) => !readOnly || rules.some((r) => r.group === g))
  const textOf = (g: RuleGroup) =>
    rules
      .filter((r) => r.group === g)
      .map((r) => r.text)
      .join('\n')
  const save = (g: RuleGroup, text: string) => {
    if (text.trim() === textOf(g)) return
    const lines = text
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => ({ group: g, text: x.slice(0, 400) }))
    // 按组的固定顺序重排，交给 Agent 时也是这个顺序
    const next = RULE_GROUPS.flatMap((k) => (k === g ? lines : rules.filter((r) => r.group === k)))
    onChange?.(next)
  }
  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((g) => (
        <label key={g} className="flex flex-col gap-1">
          <span className="text-footnote font-medium text-muted">{ruleGroupLabel(g)}</span>
          <Textarea
            defaultValue={textOf(g)}
            readOnly={readOnly}
            rows={Math.max(1, Math.min(6, rules.filter((r) => r.group === g).length || 1))}
            placeholder={t('一行一条；空着表示这方面没有要求')}
            onBlur={(e) => save(g, e.target.value)}
            className="min-h-0 text-footnote leading-relaxed"
          />
        </label>
      ))}
    </div>
  )
}
