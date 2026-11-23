import { t } from '@shared/i18n'

/**
 * 「按名字找文件」的分工说明（只读）：C++ 走 VS 的 MCP、Lua 走 IDEA 的 MCP、其他走文件索引。
 * 和提示词里给 Agent 的那段（shared/engine/prompt-parts.ts 的 searchPart）是同一个分工
 */
export function NameSearchSplit() {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-sel/50 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
      <span className="font-medium text-fg">{t('按名字找文件的分工')}</span>
      <span>
        {t(
          'C++ 源码先用 VS 的 uetovs/search_files，Lua 先用 IDEA 的 lua_code files，其他文件先查文件索引（file_index）。都没装或查不到时 Agent 才用 rg --files / find；排除目录里的文件不在索引里，直接用原命令找。',
        )}
      </span>
    </div>
  )
}
