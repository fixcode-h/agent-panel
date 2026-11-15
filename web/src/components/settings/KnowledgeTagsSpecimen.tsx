import { Search, Terminal } from 'lucide-react'
import { t } from '@shared/i18n'
import { KnowledgeTags } from '@/components/ui/knowledge-tag'
import { RowShell } from '@/components/tasks/ToolRow'

/** 设置 → 组件里「工具行下面的教训、经验标签」的示例（条目标题是示例，不翻译） */
export function KnowledgeTagsSpecimen() {
  return (
    <div className="proc-list flex w-full flex-col">
      <RowShell
        glyph={<Terminal className="h-3.5 w-3.5" />}
        verb={t('运行')}
        title="npm run test:e2e"
        ms={2300}
        open={false}
      />
      <KnowledgeTags
        items={[{ kind: 'lesson', id: 'l8k2', title: '沙箱里跑 e2e 要先去掉 ANTHROPIC_BASE_URL', why: 'command' }]}
      />
      <RowShell glyph={<Search className="h-3.5 w-3.5" />} verb={t('搜索')} title="DropTable" ms={90} open={false} />
      <KnowledgeTags items={[{ kind: 'experience', id: 'e3m1', title: '掉落表的代码和数据在哪', why: 'search' }]} />
    </div>
  )
}
