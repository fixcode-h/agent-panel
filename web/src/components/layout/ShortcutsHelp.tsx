import { t } from '@shared/i18n'
import { Modal } from '@/components/ui/modal'
import { Kbd } from '@/components/ui/kbd'
import { MOD } from './CommandPalette'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** 按键前缀（开放给插件：插件页自己的快捷键组也照这个写法） */
export const KEYS = { MOD, ALT: isMac ? '⌥' : 'Alt+', SHIFT: isMac ? '⇧' : 'Shift+' }
const { ALT, SHIFT } = KEYS

/** 一组快捷键：rows 是 [按键, 说明] */
export interface ShortcutGroup {
  key?: string
  title: string
  rows: [string, string][]
}

/**
 * 快捷键一览：按 ? 打开（不在输入框里时）。新加快捷键时在这里补一行，免得只有作者知道。
 * 插件页（例如表格插件按 F1 / Ctrl+/）打开时把自己那组传进 first，排最前
 */
export function ShortcutsHelp({
  open,
  onOpenChange,
  first,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  first?: ShortcutGroup
}) {
  const groups: ShortcutGroup[] = [
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
  if (first) groups.unshift(first)
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
