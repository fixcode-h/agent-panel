/**
 * 事件触发计划的检查（shared/schedule-trigger.ts 定义结构和判定）：去读目录、问远端、跑命令，
 * 拿到一个可以和上一次比较的值（value），以及条件成立时附给 Agent 的说明（detail）。
 * 出错一律抛出，原文由 server/schedules.ts 记进计划显示给用户，不悄悄当成「没变化」。
 */
import { readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { t } from '../shared/i18n.ts'
import { isAbsolutePath, type ScheduleTrigger, type TriggerState } from '../shared/schedule-trigger.ts'
import { capture } from './exec/process.ts'
import { runShell } from './merge-build.ts'
import { currentShell } from './shells.ts'

/** 目录最多看这么多个文件：再多每次检查都要 stat 很久，让用户换个小一点的目录 */
export const TRIGGER_MAX_FILES = 50_000
/** 看目录时跳过的子目录：版本库元数据和依赖目录，变了也不是用户关心的改动 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg'])
/** 条件成立时最多列出几个变了的文件 */
const LIST_FILES = 20
/** 问远端的时限：连不上的远端别把检查卡住 */
const GIT_TIMEOUT_MS = 60_000
/** 检查命令的时限 */
export const TRIGGER_COMMAND_TIMEOUT_MIN = 10
/** 命令输出附给 Agent 的最后几行 */
const OUTPUT_TAIL_LINES = 40
const OUTPUT_TAIL_CHARS = 4000

export interface TriggerProbe {
  /** 和上一次比较的值：目录指纹 / 提交号 / 退出码 */
  value: string
  /** 条件成立时附在提示词后面的说明（给 Agent 看，不翻译） */
  detail: string
}

/** 检查在哪个目录做：相对路径按项目目录算，空就是项目目录；不属于项目的计划只认绝对路径 */
export function triggerDir(trigger: Pick<ScheduleTrigger, 'path'>, projectDir: string): string {
  const p = trigger.path
  if (p && isAbsolutePath(p)) return p
  if (!projectDir) throw new Error(t('不属于项目的计划，目录要填绝对路径'))
  return p ? path.join(projectDir, p) : projectDir
}

async function ensureDir(dir: string) {
  const st = await stat(dir).catch(() => null)
  if (!st?.isDirectory()) throw new Error(t('目录不存在：{dir}', { dir }))
}

/** 目录指纹：所有文件的相对路径、大小、修改时间排好序算哈希；顺带找出上次检查之后改过的文件 */
async function probeFiles(dir: string, prev: TriggerState): Promise<TriggerProbe> {
  const since = Date.parse(prev.checkedAt)
  const rows: string[] = []
  const recent: string[] = []
  const walk = async (rel: string) => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(child)
        continue
      }
      if (!e.isFile()) continue
      if (rows.length >= TRIGGER_MAX_FILES)
        throw new Error(t('目录下的文件超过 {n} 个，请换一个更小的目录', { n: TRIGGER_MAX_FILES }))
      // 读的途中文件被删掉很正常（构建、导表还在写），跳过它，下次检查再算
      const st = await stat(path.join(dir, child)).catch(() => null)
      if (!st) continue
      rows.push(`${child}\t${st.size}\t${Math.floor(st.mtimeMs)}`)
      if (Number.isFinite(since) && st.mtimeMs > since) recent.push(child)
    }
  }
  await walk('')
  rows.sort()
  const value = createHash('sha1').update(rows.join('\n')).digest('hex')
  recent.sort()
  const list = recent.slice(0, LIST_FILES).map((f) => `- ${f}`)
  if (recent.length > LIST_FILES) list.push(`- ……另外还有 ${recent.length - LIST_FILES} 个`)
  const detail = list.length
    ? `目录 ${dir} 里上次检查之后改过的文件：\n${list.join('\n')}`
    : `目录 ${dir} 里有文件被删除、改名或移走（没有新改动的文件）。`
  return { value, detail }
}

/** 远端分支现在的提交：ls-remote 不用拉代码，也不动工作区 */
async function probeGit(trigger: ScheduleTrigger, dir: string, prev: TriggerState): Promise<TriggerProbe> {
  const remote = trigger.remote || 'origin'
  const r = await capture(
    'git',
    ['ls-remote', remote, `refs/heads/${trigger.branch}`],
    dir,
    // 要密码的远端别弹出输入提示把检查卡住，直接失败给用户看
    { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    GIT_TIMEOUT_MS,
  )
  if (r.spawnError) throw new Error(t('git 没跑起来：{e}', { e: r.spawnError }))
  if (r.killed === 'timeout') throw new Error(t('读取远端分支超时：{remote}', { remote }))
  if (r.code !== 0) throw new Error(t('读取远端分支失败：{e}', { e: (r.stderr || r.stdout).trim().slice(-500) }))
  const sha = r.stdout.trim().split(/\s+/)[0] ?? ''
  if (!sha) throw new Error(t('远端 {remote} 上没有分支 {branch}', { remote, branch: trigger.branch }))
  const from = prev.baseline ? prev.baseline.slice(0, 10) : '（未知）'
  return {
    value: sha,
    detail: `远端分支 ${remote}/${trigger.branch} 有新提交：${from} → ${sha.slice(0, 10)}（工作目录 ${dir}，需要时先 git fetch ${remote} ${trigger.branch}）。`,
  }
}

/** 跑一次命令拿退出码：输出只留最后一段附给 Agent */
async function probeCommand(trigger: ScheduleTrigger, dir: string, prev: TriggerState): Promise<TriggerProbe> {
  let out = ''
  const add = (s: string) => {
    out += s
    if (out.length > OUTPUT_TAIL_CHARS * 4) out = out.slice(-OUTPUT_TAIL_CHARS * 2)
  }
  const r = await runShell(trigger.command, dir, {
    shell: (await currentShell()) ?? undefined,
    timeoutMs: TRIGGER_COMMAND_TIMEOUT_MIN * 60_000,
    onLine: (l) => add(`${l}\n`),
    onStderr: add,
  })
  if (r.spawnError) throw new Error(t('命令没跑起来：{e}', { e: r.spawnError }))
  if (r.killed === 'timeout')
    throw new Error(t('检查命令超过 {n} 分钟没跑完，已停止', { n: TRIGGER_COMMAND_TIMEOUT_MIN }))
  if (r.code === null) throw new Error(t('检查命令被中途结束，没有拿到退出码'))
  const tail = out.split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join('\n').slice(-OUTPUT_TAIL_CHARS).trim()
  const from = prev.baseline || '（未知）'
  return {
    value: String(r.code),
    detail: [
      `命令 \`${trigger.command}\`（工作目录 ${dir}）的退出码从 ${from} 变成 ${r.code}。`,
      ...(tail ? ['输出的最后几行：', '```', tail, '```'] : []),
    ].join('\n'),
  }
}

/** 检查一次；projectDir 是计划所在项目的目录（聊天计划为空） */
export async function probeTrigger(
  trigger: ScheduleTrigger,
  projectDir: string,
  prev: TriggerState,
): Promise<TriggerProbe> {
  const dir = triggerDir(trigger, projectDir)
  await ensureDir(dir)
  switch (trigger.kind) {
    case 'files':
      return probeFiles(dir, prev)
    case 'git':
      return probeGit(trigger, dir, prev)
    case 'command':
      return probeCommand(trigger, dir, prev)
    default:
      throw new Error(t('这条计划不是按事件触发的'))
  }
}
