/**
 * 面板替 Agent 跑一次校验（ADR 0086）的结果：调用记录（CallRecord.verify）、交给 Agent 的说明、演示后端都用这一份形状。
 * 两种来由：auto 是 Agent 改完对得上的文件、去做别的事时面板自己跑的；replaces 是改道模式下 Agent 自己跑 luac 这类，
 * 面板改用自建工具代答的
 */
import { z } from 'zod'

export const VERIFY_OUTCOMES = ['ok', 'errors', 'failed', 'timeout', 'spawn'] as const
export type VerifyOutcome = (typeof VERIFY_OUTCOMES)[number]

export const VerifyRun = z.object({
  trigger: z.enum(['auto', 'replaces']),
  /** 自建工具的 id 和中文名 */
  tool: z.string(),
  name: z.string(),
  /** 查了哪些文件（相对项目根） */
  files: z.array(z.string()),
  /**
   * ok 通过；errors 认出了报错行；failed 退出码不对但没认出报错行（看输出尾部）；
   * timeout 超过限时被面板停了；spawn 工具本身没跑起来（程序不在、参数填不上）
   */
  outcome: z.enum(VERIFY_OUTCOMES),
  /** 认出的报错条数 */
  errors: z.number(),
  ms: z.number(),
  /** 超时、没跑起来的原因，或「还有几个文件没查」 */
  note: z.string().optional(),
  /** 完整输出的日志文件 */
  logFile: z.string().optional(),
})
export type VerifyRun = z.infer<typeof VerifyRun>
