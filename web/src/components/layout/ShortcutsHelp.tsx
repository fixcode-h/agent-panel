import { t } from '@shared/i18n'
import { Modal } from '@/components/ui/modal'
import { Kbd } from '@/components/ui/kbd'
import { MOD } from './CommandPalette'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const ALT = isMac ? '⌥' : 'Alt+'
const SHIFT = isMac ? '⇧' : 'Shift+'

/**
 * 快捷键一览：按 ? 打开（不在输入框里时）。新加快捷键时在这里补一行，免得只有作者知道。
 * 表格页按 F1 / Ctrl+/ 打开时 first 传 tables，表格那组排最前
 */
export function ShortcutsHelp({
  open,
  onOpenChange,
  first,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  first?: 'tables'
}) {
  const tables = {
    key: 'tables',
    title: t('表格'),
    rows: [
      ['Enter / F2', t('改当前格；改的时候 Enter 确认、Esc 取消')],
      [`${MOD}Enter`, t('改格子时把值填进选中的每一格')],
      [`${MOD}F`, t('表格顶上的查找条（Enter 下一个、{shift}Enter 上一个）', { shift: SHIFT })],
      [`${MOD}H`, t('查找替换')],
      [`${MOD}G`, t('跳到第几行或某个主键')],
      [`${MOD}↑ ↓ ← →`, t('跳到这一段数据的边缘')],
      [`${MOD}Home / ${MOD}End`, t('跳到开头 / 结尾')],
      ['PageUp / PageDown', t('翻页')],
      [`${SHIFT}Space / ${MOD}Space`, t('选中整行 / 整列')],
      [`${MOD}${SHIFT}= / ${MOD}-`, t('在上方插入一行 / 删除选中的行')],
      [`${MOD}D / ${MOD}${SHIFT}D`, t('向下填充 / 按序列递增填充')],
      [`${MOD}C / X / V`, t('复制、剪切、粘贴（和 Excel / WPS 互通）')],
      [`${MOD}Z / ${MOD}Y`, t('撤销 / 重做')],
      [`${MOD}S`, t('保存')],
      [`${MOD}${t('点击')}`, t('引用格：跳到被引用的那一行')],
      [`F1 / ${MOD}/`, t('打开这份快捷键一览')],
    ] as [string, string][],
  }
  const groups: { key?: string; title: string; rows: [string, string][] }[] = [
    {
      title: t('全局'),
      rows: [
        [`${MOD}K`, t('命令面板：搜对话、跳页面')],
        [`${MOD}${SHIFT}O`, t('新建任务（在 Chat 页时新建聊天）')],
        [`${MOD}B`, t('收起 / 展开侧栏')],
        [`${ALT}↑ / ${ALT}↓`, t('切到上一个 / 下一个对话')],
        ['?', t('打开这份快捷键一览')],
      ],
    },
    {
      title: t('对话输入框'),
      rows: [
        ['Enter', t('发送')],
        [`${SHIFT}Enter`, t('换行')],
        [`${MOD}Enter`, t('打断正在执行的这一轮并发送')],
        ['↑', t('输入框空着时取回上一条发出的话')],
        ['Esc', t('停止正在执行的任务（会先确认）')],
        ['/', t('斜杠命令')],
        ['@', t('引用项目里的文件')],
      ],
    },
  ]
  if (first === 'tables') groups.unshift(tables)
  else groups.push(tables)
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('快捷键')} closeOnOutside>
      <div className="flex flex-col gap-5">
        {groups.map((g) => (
          <section key={g.key ?? g.title} className="flex flex-col gap-2">
            <h3 className="text-footnote font-medium text-subtle">{g.title}</h3>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-body">
              {g.rows.map(([keys, what]) => (
                <div key={keys} className="contents">
                  <dt>
                    <Kbd>{keys}</Kbd>
                  </dt>
                  <dd className="text-fg">{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}
