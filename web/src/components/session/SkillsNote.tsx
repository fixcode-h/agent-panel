import { t } from '@shared/i18n'
import type { Task } from '@shared/schema'
import { SessionDisclosure, SessionDisclosureItem } from './SessionCard'
import { sessionUsage } from './SessionContext'

/**
 * 会话栏「环境」里的一行「技能」（ADR 0083）：这一轮开跑时带了哪些技能（角色自带、每个对话都带），
 * 之后面板按情境推了哪些正文。数据是 runner 和钩子记进会话用量的（shared/skills/usage.ts），都没有就不显示
 */
export function SkillsNote({ task }: { task: Task }) {
  const sk = sessionUsage(task)?.usage.skills
  if (!sk) return null
  // 推过的技能里也可能有角色自带的（条件对上时把正文直接给它），列表里只写一次、标成「推过」
  const carried = sk.carried.filter((n) => !sk.pushed.includes(n))
  const n = carried.length + sk.pushed.length
  if (!n) return null
  return (
    <div data-session-skills>
      <SessionDisclosure
        label={
          sk.pushed.length
            ? t('技能：带 {c} 个，推过 {p} 个', { c: sk.carried.length, p: sk.pushed.length })
            : t('技能：带 {c} 个', { c: sk.carried.length })
        }
        count={n}
      >
        {sk.pushed.map((name) => (
          <SessionDisclosureItem
            key={`p:${name}`}
            name={name}
            value={t('推过')}
            title={t('面板按情境把正文推给了 Agent')}
          />
        ))}
        {carried.map((name) => (
          <SessionDisclosureItem key={`c:${name}`} name={name} value={t('开跑带上')} />
        ))}
      </SessionDisclosure>
    </div>
  )
}
