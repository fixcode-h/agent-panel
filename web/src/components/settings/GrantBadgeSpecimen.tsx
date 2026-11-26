import { useState } from 'react'
import { Wrench } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TaskMessage, ToolGrant } from '@shared/schema'
import { DecisionLine, GrantBadge, GrantRunRow, GrantSection } from '@/components/ui/grant-badge'
import { RowShell } from '@/components/tasks/ToolRow'

// 示例数据（命令、工具名照真实的写，不翻译）
const at = new Date().toISOString()
const note = (id: string, title: string): TaskMessage => ({
  id,
  role: 'system',
  agentId: '',
  step: '',
  text: '',
  tools: [],
  at,
  grant: { via: 'rule', rule: 'ctool:project:export-tables', label: '自建工具「导出设计表」', title },
})
const NOTES = [
  note('g1', 'python export-excel-tables.py --excel FunctionalNPC/C_ClinkGlasses.xlsx --sheet C_ClinkGlasses'),
  note('g2', 'python export-excel-tables.py --excel FunctionalNPC/C_NpcTemplate.xlsx --sheet C_NpcTable'),
]
const DECISION: TaskMessage = {
  ...note('d1', '运行自建工具「导出设计表」？'),
  grant: {
    via: 'user',
    always: true,
    rule: 'ctool:project:export-tables',
    label: '',
    title: '运行自建工具「导出设计表」？',
  },
}
const GRANT: ToolGrant = { via: 'rule', label: '自建工具「导出设计表」', note: 'g1' }
const TASK = { messages: [DECISION, ...NOTES] }

/** 设置 → 组件里「放行小标」示例：你允许了那一行、带小标的工具卡片（下一行点开看怎么放行的）、挂不上卡片时合并的一行 */
export function GrantBadgeSpecimen() {
  const [open, setOpen] = useState(true)
  const glyph = <Wrench className="h-3.5 w-3.5 text-(--hl-func)" />
  return (
    <div className="proc-list flex w-full flex-col">
      <DecisionLine m={DECISION} task={TASK} />
      <RowShell
        glyph={glyph}
        verb={t('自建工具')}
        title="C_NpcTemplate.xlsx"
        tail={<GrantBadge grant={{ ...GRANT, note: 'g2' }} />}
        ms={3100}
        open={false}
      />
      <RowShell
        glyph={glyph}
        verb={t('自建工具')}
        title="C_ClinkGlasses.xlsx"
        tail={<GrantBadge grant={GRANT} />}
        ms={2400}
        open={open}
        onToggle={() => setOpen(!open)}
      >
        <GrantSection grant={GRANT} task={TASK} />
      </RowShell>
      <GrantRunRow run={NOTES} task={TASK} />
    </div>
  )
}
