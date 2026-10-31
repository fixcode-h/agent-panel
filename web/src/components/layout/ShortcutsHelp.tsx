import { t } from '@shared/i18n'
import { Modal } from '@/components/ui/modal'
import { Kbd } from '@/components/ui/kbd'
import { MOD } from './CommandPalette'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const ALT = isMac ? '⌥' : 'Alt+'
const SHIFT = isMac ? '⇧' : 'Shift+'

/** 快捷键一览：按 ? 打开（不在输入框里时）。新加快捷键时在这里补一行，免得只有作者知道 */
export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: t('全局'),
      rows: [
        [`${MOD}K`, t('命令面板：搜对话、跳页面')],
        [`${MOD}${SHIFT}O`, t('新建任务')],
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
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('快捷键')} closeOnOutside>
      <div className="flex flex-col gap-5">
        {groups.map((g) => (
          <section key={g.title} className="flex flex-col gap-2">
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
