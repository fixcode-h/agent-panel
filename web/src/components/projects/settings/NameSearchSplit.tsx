import { t } from '@shared/i18n'

/**
 * 「找文件、找代码」的分工说明（只读）：Agent 只调面板的 find，走哪条路由面板定（ADR 0081 能力路由）。
 * 和提示词里给 Agent 的那段（shared/engine/prompt-parts.ts 的 searchPart）是同一个分工
 */
export function NameSearchSplit() {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-sel/50 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
      <span className="font-medium text-fg">{t('找文件、找代码的分工')}</span>
      <span>
        {t(
          'Agent 找文件、找代码都调面板的 find：找文件查这份索引，找 C++ 代码走 VS、Lua 走 IDEA，都用不了时面板自己按文本找。排除目录里的文件不在索引里，Agent 直接用 rg / ls 找。',
        )}
      </span>
    </div>
  )
}
