import { t } from '@shared/i18n'
import { ReportCompare, type CompareItem } from '@/components/ui/report-compare'
import { StatusPill } from '@/components/ui/status-pill'

/** 设置 → 组件里「对比上一份」的示例：一节改了、一节新加、两节没改（内容是示例，不翻译） */
const ITEMS: CompareItem[] = [
  {
    title: '根因',
    state: 'changed',
    lines: [
      { kind: 'ctx', text: '保存时没有等写盘完成就关闭了弹窗。' },
      { kind: 'del', text: '只在 Windows 上出现。' },
      { kind: 'add', text: '所有平台都会出现，Windows 上磁盘慢更容易碰到。' },
    ],
    add: 1,
    del: 1,
  },
  {
    title: '证据链',
    state: 'added',
    lines: [{ kind: 'add', text: '用户补充的日志第 12 行：close 在 write 完成前 30ms。' }],
    add: 1,
    del: 0,
  },
  { title: '影响面', state: 'same', lines: [], add: 0, del: 0 },
  { title: '时间线', state: 'same', lines: [], add: 0, del: 0 },
]

export function ReportCompareSpecimen() {
  return (
    <ReportCompare
      className="w-full max-w-xl"
      items={ITEMS}
      summary={
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="wait">{t('结论已改')}</StatusPill>
          <span className="text-muted">{t('第 {a} 版 → 第 {b} 版', { a: '1', b: '1.1' })}</span>
        </div>
      }
    />
  )
}
