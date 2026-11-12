import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { commandKey, runSegments } from '../shared/command-scope.ts'
import { DATA_DIR } from './store.ts'
import { log } from './log.ts'

/**
 * 按项目记命令在前台跑了多久（后台命令重新设计，用户 2026-11-12 定）：`npm run build`、`tsc`、`cargo build` 这类
 * 「时长看项目」的命令，在这个项目里跑过一次超过 SLOW_MS，下次在前台跑时长命令守卫就拦下、让它交给 run_background，
 * 不用用户在守卫设置里一条条补前缀。只记前台命令工具（CLI 自己的 Bash / PowerShell）的用时：交给后台的本来就在后台。
 * 存在数据目录的 command-times.json，按项目 id 分开；每个项目只留最近的 MAX_KEYS 个名字
 */
export const SLOW_MS = 60_000
const MAX_KEYS = 200
const FILE = () => path.join(process.env.AGENT_PANEL_DATA ?? DATA_DIR, 'command-times.json')

interface Rec {
  ms: number
  at: string
}
let data: Record<string, Record<string, Rec>> | null = null // 模块状态：会话，跟着进程或连接一起没
let timer: ReturnType<typeof setTimeout> | null = null

function load() {
  if (data) return data
  try {
    data = JSON.parse(readFileSync(FILE(), 'utf8')) as Record<string, Record<string, Rec>>
  } catch {
    data = {}
  }
  return data
}

/** 攒一秒再写：一轮里连着跑好几条命令时只写一次；写失败只记日志，不影响对话 */
function save() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    try {
      mkdirSync(path.dirname(FILE()), { recursive: true })
      writeFileSync(FILE(), JSON.stringify(data ?? {}))
    } catch (e) {
      log.warn('command-times', '命令用时没能写盘', { error: (e as Error).message })
    }
  }, 1000)
  timer.unref?.()
}

/**
 * 记一次前台命令的用时：整条命令里只有一段不是快命令时才记（`cd web && npm run build` 记 npm run build；
 * `npm ci && npm run build` 分不清是哪段慢，不记）
 */
export function noteCommandTime(projectId: string, command: string, ms: number) {
  if (!projectId || !command.trim() || !(ms > 0)) return
  const keys = [...new Set(runSegments(command).map(commandKey).filter(Boolean))]
  if (keys.length !== 1) return
  const all = load()
  const mine = (all[projectId] ??= {})
  // 重新插入放到最后：超过上限时删最早的
  delete mine[keys[0]]
  mine[keys[0]] = { ms, at: new Date().toISOString() }
  const names = Object.keys(mine)
  for (const k of names.slice(0, Math.max(0, names.length - MAX_KEYS))) delete mine[k]
  save()
}

/** 这一段命令在这个项目里上次跑了多久，超过 SLOW_MS 才返回（长命令守卫用） */
export function knownSlow(projectId: string, seg: string): number | undefined {
  const key = projectId ? commandKey(seg) : ''
  const rec = key ? load()[projectId]?.[key] : undefined
  return rec && rec.ms >= SLOW_MS ? rec.ms : undefined
}

/** 测试用：丢掉内存里的副本，下次从文件重读 */
export function resetCommandTimes() {
  data = null
}
