import { z } from 'zod'

/**
 * UE 项目里子对话申请的编译（ADR 0004）：谁申请过、父对话替它起了哪几条编译、结果是什么，记在子对话任务上（会落盘）。
 *
 * 以前结果能不能回到子对话，全看父对话调用 request_build 时有没有填 children：漏填、写成 child，
 * 或者面板重启丢了内存里的对应关系，结果就只推给父对话。子对话已经请了收尾时两边互相等，子对话一直停在「待收尾」
 * （用户 2026-11-04 报）。现在由面板记账：父对话漏填时按「谁申请过还没编」自动补上，结果按这里的记录推回，
 * 共用目录的子对话没拿到这次改动的编译通过，submit_merge 直接拒（面板侧的硬约束，不靠提示词）。
 * 这里只放结构和纯函数；起命令、推消息在 server/tasks/merge.ts、server/tasks/jobs.ts
 */
export const BuildAsk = z.object({
  /** asked 申请了还没编；building 父对话已经替它起了编译；passed / failed 这次的结果 */
  state: z.enum(['asked', 'building', 'passed', 'failed']),
  at: z.string(),
  note: z.string().default(''),
  /** 申请时要编译的改动的指纹（buildSig）：编译通过后又改了要编译的文件，指纹对不上，要重新申请 */
  sig: z.string().default(''),
  /** 父对话替它起的编译命令（后台命令编号）：每条跑完从这里划掉，全划完才算通过 */
  jobs: z.array(z.string()).default([]),
  /** 结果的一行摘要：失败时是报错的开头 */
  info: z.string().default(''),
})
export type BuildAsk = z.infer<typeof BuildAsk>

/** 要编译的改动的指纹：文件和增删行数，顺序无关 */
export const buildSig = (changes: { path: string; add: number; del: number }[]) =>
  changes
    .map((c) => `${c.path}:+${c.add}-${c.del}`)
    .sort()
    .join('|')

type Kid = { id: string; parentTaskId: string; buildAsk?: BuildAsk; resolved?: boolean }

/**
 * 这次编译替哪些子对话编：父对话写了 children（或旧写法 child）就按它，只认它名下的；
 * 一个都没写时，补上名下申请过、还没开编的子对话。返回 [这次替谁编, 其中是面板补上的]
 */
export function buildKids(kids: Kid[], parentId: string, named: string[]): [string[], string[]] {
  const mine = kids.filter((k) => k.parentTaskId === parentId && !k.resolved)
  const want = [...new Set(named.map((x) => x.trim()).filter(Boolean))]
  if (want.length) return [want.filter((id) => mine.some((k) => k.id === id)), []]
  const asked = mine.filter((k) => k.buildAsk?.state === 'asked').map((k) => k.id)
  return [asked, asked]
}

/**
 * 一条编译命令跑完：划掉它，失败就整次失败，全部划完才算通过。
 * 返回更新后的记录和这次有没有出结果（还有没跑完的命令时为 undefined，先不推）
 */
export function settleBuildJob(
  ask: BuildAsk,
  jobId: string,
  ok: boolean,
  info: string,
  now: string,
): { ask: BuildAsk; result?: 'passed' | 'failed' } {
  if (ask.state !== 'building' || !ask.jobs.includes(jobId)) return { ask }
  if (!ok) return { ask: { ...ask, state: 'failed', jobs: [], info, at: now }, result: 'failed' }
  const jobs = ask.jobs.filter((x) => x !== jobId)
  if (jobs.length) return { ask: { ...ask, jobs } }
  return { ask: { ...ask, state: 'passed', jobs: [], info, at: now }, result: 'passed' }
}

/**
 * 共用目录的 UE 子对话请父对话验收前的核对：改了要编译的文件，就要有这次改动的编译通过结果。
 * sig 是现在要编译的改动的指纹（空表示没改要编译的文件，不用核对）；能请求收尾返回空串
 */
export function buildGate(ask: BuildAsk | undefined, sig: string): string {
  if (!sig) return ''
  const again = '改完、检查完调用 request_build 向父对话申请编译，结果出来面板会推给你；编译通过后再调用 submit_merge。'
  if (!ask) return `没有请求收尾：这是 UE 项目，你改了要编译的文件，还没申请过编译。${again}`
  if (ask.state === 'asked' || ask.state === 'building')
    return '没有请求收尾：编译还没出结果（已经申请了，在等父对话编译）。现在结束这一轮，结果出来面板会推给你；通过了再调用 submit_merge。'
  if (ask.state === 'failed')
    return `没有请求收尾：上次编译没通过（${ask.info || '见推给你的编译结果'}）。修好后${again}`
  if (ask.sig !== sig) return `没有请求收尾：编译通过之后又改了要编译的文件，这次的改动还没编译过。${again}`
  return ''
}
