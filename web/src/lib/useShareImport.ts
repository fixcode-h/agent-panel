import { useState } from 'react'
import { toast } from '@/lib/toast'
import type { ShareKind, ShareMode } from '@shared/agent-share'
import { ImportConflict, importShare, type ImportResult } from '@/lib/transfer'

/**
 * 页面里的「导入分享包」：选文件 → 校验格式和指纹 → 撞上同名时弹选择（覆盖 / 另存为副本）。
 * 角色页和工作流页共用：两页只是导入后怎么刷新、提示什么不一样，流程是同一套。
 */
export function useShareImport(kind: ShareKind, onDone: (r: ImportResult) => void) {
  // 冲突时连同文件内容一起记住：用户选完「覆盖 / 另存为副本」再拿它跑一次，不用重新选文件
  const [conflict, setConflict] = useState<{ error: ImportConflict; text: string }>()

  const run = async (text: string, mode?: ShareMode) => {
    try {
      const r = await importShare(text, mode, kind)
      setConflict(undefined)
      onDone(r)
    } catch (e) {
      if (e instanceof ImportConflict) setConflict({ error: e, text })
      else toast.error((e as Error).message)
    }
  }

  return {
    conflict: conflict?.error,
    /** 放在隐藏的 <input type="file"> 的 onChange 上 */
    onFile: async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0]
      e.target.value = ''
      if (f) await run(await f.text())
    },
    /** 冲突弹窗里选了「覆盖本机那份」或「另存为副本」 */
    pick: (mode: ShareMode) => {
      const c = conflict?.text
      setConflict(undefined)
      if (c) void run(c, mode)
    },
    close: () => setConflict(undefined),
  }
}
