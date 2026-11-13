import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { ChatQuotes, type ChatQuoteItem } from '@/components/ui/chat-quotes'
import { StatusPill } from '@/components/ui/status-pill'

/** 设置 → 组件里「依据你在对话里说的」的示例（内容是示例，不翻译） */
const ITEMS: ChatQuoteItem[] = [
  { id: 'q1', at: '2026-11-13T10:58:40Z', text: '检测盒和判定占用不是同一个东西么' },
  { id: 'q2', at: '2026-11-13T11:29:31Z', text: '调整吧，改成 Mesh 的 Bound 的并集，作为检测范围吧' },
  { id: 'q3', at: '2026-11-13T11:47:20Z', text: '目前已经修好了，去掉测试 log，就按照调整碰撞检测的体积来修改吧' },
]

export function ChatQuotesSpecimen() {
  return (
    <ChatQuotes
      className="w-full max-w-xl"
      title={t('依据你在对话里说的（{k} 句）', { k: ITEMS.length })}
      items={ITEMS}
      onJump={() => {}}
      aside={
        <>
          <StatusPill tone="wait">{t('比第 {v} 版：结论已改', { v: '1' })}</StatusPill>
          <StatusPill tone="ok">{t('你在对话里确认了')}</StatusPill>
        </>
      }
      footer={
        <>
          <span className="min-w-0 flex-1 text-caption text-subtle">
            {t('它把你最后一句当成了确认；理解错了就撤回，这一版回到等你确认')}
          </span>
          <Button size="sm" variant="secondary">
            {t('不是这个意思')}
          </Button>
        </>
      }
    />
  )
}
