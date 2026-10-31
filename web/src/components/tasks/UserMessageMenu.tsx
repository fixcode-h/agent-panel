import { GitFork, GraduationCap, Undo2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { MessageMenu, type MessageMenuItem } from '@/components/chat/ChatMessage'

/**
 * 对话里用户消息的「⋯」：撤回重发、分叉、记成项目教训。每项写清楚是什么，消息下面不再摆一排看不懂的图标；
 * 对话在跑时撤回、分叉照样列着，灰掉并写原因，不让菜单忽长忽短
 */
export function UserMessageMenu({
  chat,
  canRewind,
  canLesson,
  running,
  onRewind,
  onFork,
  onLesson,
}: {
  /** 聊天模式、不是导入的对话：才有撤回和分叉 */
  chat: boolean
  /** 第一条不能撤回 */
  canRewind: boolean
  /** 项目里的对话才能记成项目教训 */
  canLesson: boolean
  running: boolean
  onRewind: () => void
  onFork: () => void
  onLesson: () => void
}) {
  const items: MessageMenuItem[] = []
  if (chat && canRewind)
    items.push({
      label: t('编辑并重发'),
      hint: t('撤回这条和之后的对话，原文放回输入框'),
      icon: Undo2,
      onSelect: onRewind,
      disabledReason: running ? t('对话执行中，停下后才能撤回') : undefined,
    })
  if (chat)
    items.push({
      label: t('从这里分叉'),
      hint: t('新开一个对话，带着到这条为止的内容'),
      icon: GitFork,
      onSelect: onFork,
      disabledReason: running ? t('对话执行中，停下后才能分叉') : undefined,
    })
  // 用户消息常常是一次纠正：项目里的对话随时可以记成项目教训
  if (canLesson)
    items.push({
      label: t('记成项目教训'),
      hint: t('以后这个项目里的角色都照着做'),
      icon: GraduationCap,
      onSelect: onLesson,
      separated: items.length > 0,
    })
  return <MessageMenu items={items} />
}
