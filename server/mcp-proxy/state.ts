/**
 * 代理的运行时记账（ADR 0085）：
 * - 最近代理出过错的服务：一段时间内开跑时先退回直接挂在 CLI 上（不让 Agent 下一轮又碰上同一个错），过了时间再试代理；
 * - 每个项目、每个 CLI 最近一次开跑时算出的「给 Agent 的工具」：设置页打开时按它显示，写进缓存目录，重启后还在
 */
import path from 'node:path'
import { ExposureRun } from '../../shared/mcp-proxy/types.ts'
import { CACHE_DIR, readJson, writeJsonAtomic } from '../store.ts'
import { log } from '../log.ts'

/** 代理出错后多久内退回直接挂 */
export const FAIL_MS = 10 * 60_000

const failures = new Map<string, { at: number; why: string }>() // 模块状态：运行时，最近代理出错的服务，过了 FAIL_MS 作废
let runs: Record<string, ExposureRun> | undefined // 模块状态：缓存副本，第一次用到时读缓存文件

const FILE = () => path.join(CACHE_DIR, 'mcp-exposure.json')

export function noteProxyFailure(server: string, why: string) {
  failures.set(server, { at: Date.now(), why })
  log.warn('mcp-proxy', `代理 ${server} 出错，${Math.round(FAIL_MS / 60_000)} 分钟内开跑时改为直接挂在 CLI 上`, {
    error: why,
  })
}

export function recentFailure(server: string, now = Date.now()) {
  const f = failures.get(server)
  if (!f) return undefined
  if (now - f.at > FAIL_MS) {
    failures.delete(server)
    return undefined
  }
  return f
}

async function load() {
  if (runs) return runs
  const raw = (await readJson(FILE())) as Record<string, unknown> | undefined
  runs = {}
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const p = ExposureRun.safeParse(v)
    if (p.success) runs[k] = p.data
  }
  return runs
}

/** 记下这一轮的结果；和上一轮一样时不写盘（每轮都开跑，内容多半不变） */
export async function noteExposure(run: ExposureRun) {
  const all = await load()
  const key = `${run.projectId}\u0000${run.cli}`
  const same = JSON.stringify(all[key]?.plan) === JSON.stringify(run.plan)
  all[key] = run
  if (same) return
  await writeJsonAtomic(FILE(), all).catch((e) =>
    log.warn('mcp-proxy', '「给 Agent 的工具」记不进缓存', { error: (e as Error).message }),
  )
}

/** 最近的结果，新的在前；给了项目只看这个项目的 */
export async function exposureRuns(projectId?: string): Promise<ExposureRun[]> {
  return Object.values(await load())
    .filter((r) => !projectId || r.projectId === projectId)
    .sort((a, b) => b.at - a.at)
}

/** 测试用：清掉出错记录和内存里的结果 */
export function resetProxyState() {
  failures.clear()
  runs = {}
}
