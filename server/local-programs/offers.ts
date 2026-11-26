/**
 * 面板要用的本机程序没装时的提醒（定义在 shared/local-programs/defs.ts）：功能发现没装时 reportMissing，
 * 打开着的页面在输入框上方弹「安装 / 拒绝」。状态只在内存：拒绝管到面板重启，重启后还没装、又用到时再问；
 * 装上了（安装作业成功，或用户自己装好、下次再用到时不再报）就撤掉
 */
import { localProgram, type ProgramOffer, type ProgramPlatform } from '../../shared/local-programs/defs.ts'
import { resolveCommand } from '../cli/source.ts'
import { signalPages } from '../page-events.ts'

interface Offer {
  /** 正在装的后台作业 */
  jobId?: string
  error?: string
}

const offers = new Map<string, Offer>() // 模块状态：运行时，面板重启后重新发现
const declined = new Set<string>() // 模块状态：运行时，拒绝只管到面板重启

export const platformOf = (): ProgramPlatform =>
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'

/** 这台电脑上能用的一键安装做法：包管理器找得到才算（sudo 还要后面的包管理器找得到） */
export function setupSteps(id: string, has: (cmd: string) => boolean): string[][] {
  const def = localProgram(id)
  return (def?.setup[platformOf()] ?? []).filter((s) => has(s[0]) && (s[0] !== 'sudo' || has(s[2])))
}

export const hasCommand = (cmd: string) => !!resolveCommand(cmd)

export function listOffers(): ProgramOffer[] {
  return [...offers].flatMap(([id, o]) => {
    const def = localProgram(id)
    if (!def) return []
    return [
      {
        id,
        name: def.name,
        why: def.why,
        installHint: def.install[platformOf()] ?? '',
        canInstall: setupSteps(id, hasCommand).length > 0,
        ...(o.jobId ? { jobId: o.jobId } : {}),
        ...(o.error ? { error: o.error } : {}),
      },
    ]
  })
}

const push = () => signalPages({ type: 'local-programs', offers: listOffers() })

/** 功能发现程序没装：没拒绝过、还没在问，就加一条提醒推给页面 */
export function reportMissing(id: string) {
  if (!localProgram(id) || declined.has(id) || offers.has(id)) return
  offers.set(id, {})
  push()
}

export function declineOffer(id: string) {
  declined.add(id)
  offers.delete(id)
  push()
}

/** 安装作业的进展：开始（jobId）、失败（error）、装好（撤掉） */
export function offerInstalling(id: string, jobId: string) {
  offers.set(id, { jobId })
  push()
}
export function offerFailed(id: string, error: string) {
  offers.set(id, { error })
  push()
}
export function offerInstalled(id: string) {
  offers.delete(id)
  push()
}

export const offerOf = (id: string) => offers.get(id)

/** 测试用：清空状态 */
export function resetOffers() {
  offers.clear()
  declined.clear()
}
