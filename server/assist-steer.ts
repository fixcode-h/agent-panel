/**
 * AI 创建 / 分析执行中插话：和对话模式一样随时说，交给正在跑的 CLI 接着处理，不用排队等这一轮结束。
 * 有插话协议的（Claude Code、Codex、Pi）直接插话；没有协议但能用面板工具取补充的（notes）登记给它取；
 * 两样都不行（进程还没起来、这一轮已经收尾）时返回 false，由页面排到下一轮再发。
 */
import type { CliDefinition } from '../shared/clis.ts'
import type { CliControl } from './exec/invoke.ts'
import { steerNote } from './exec/steering.ts'

export interface AssistSteer {
  /** 交给 invokeCli 的 onControl / readNotes */
  onControl: (c: CliControl) => void
  readNotes?: () => string[]
  /** 交给正在跑的 CLI；true 表示 CLI 收下了（插话）或登记好了（notes） */
  steer: (text: string) => Promise<boolean>
  /** 登记了但到结束都没被取走的：页面放回队列，下一轮再发 */
  unread: () => string[]
}

export function assistSteer(def: Pick<CliDefinition, 'notes' | 'mcp'>): AssistSteer {
  let control: CliControl | undefined
  const pending: string[] = []
  const canNotes = !!def.notes && !!def.mcp
  return {
    onControl: (c) => (control = c),
    readNotes: canNotes ? () => pending.splice(0).map((x) => steerNote(x, true)) : undefined,
    steer: async (text) => {
      if (control && (await control.steer(steerNote(text, true)).catch(() => false))) return true
      if (!canNotes) return false
      pending.push(text)
      return true
    },
    unread: () => pending.splice(0),
  }
}
