/**
 * 面板复核回归测试（分析稿 B9，判定和渲染在 shared/bug/recheck.ts）：修复、验证这一版交上来、子对话这一轮结束后，
 * 把档案里写的回归测试命令在两处各跑一次：
 * - 改前：对话开始时的提交（Task.baseRef）开一个临时的分离工作区，拷进现在的测试文件（新写的回归测试改前还不存在），
 *   依赖目录（node_modules 这类）链接到现在的目录，不重新安装；
 * - 改后：现在的代码（对话的工作区）。
 * 每条命令有超时，结果（退出码、用时、输出最后一段）原样记进这一版报告；跑不了的写清原因，界面标「面板没有复核」。
 * 不悄悄重试。复核完如果用户开着「没有要注意的就自动通过」，按结果决定这一版能不能自动通过（shared/bug/auto.ts）
 */
import { copyFile, lstat, mkdir, mkdtemp, rm, stat, symlink, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '../../shared/schema.ts'
import type { Diagnosis, Recheck, RecheckRun } from '../../shared/bug/diagnosis-schema.ts'
import { autoApprove, autoBlock, autoOn } from '../../shared/bug/auto.ts'
import { phaseOf, revOf } from '../../shared/bug/phase.ts'
import {
  needsRecheck,
  ranInConversation,
  RECHECK_OUT_MAX,
  RECHECK_TIMEOUT_MS,
  recheckCommands,
  TEST_FILE,
} from '../../shared/bug/recheck.ts'
import { t } from '../../shared/i18n.ts'
import { runShell } from '../merge-build.ts'
import { currentShell } from '../shells.ts'
import { noPushEnv } from '../exec/no-push.ts'
import { gitExec } from '../exec/git.ts'
import { log } from '../log.ts'
import type { TasksScope } from './scope.ts'
import { taskSet } from '../runtime/task-state.ts'

const git = (dir: string, args: string[]) => gitExec(dir, args).then((r) => r.stdout)

/** 改前那一次链接过去的依赖目录：只认这几个常见的（构建产物不链，免得改前那一次写进现在的产物里） */
const DEP_DIRS = ['node_modules', '.venv', 'venv']

/** 测试里缩短超时 */
const timeoutMs = () => Number(process.env.AGENT_PANEL_RECHECK_TIMEOUT_MS) || RECHECK_TIMEOUT_MS

/** 正在复核的对话：面板重启后记成 running 的那份没人在跑，下一轮结束时重新跑 */
const running = taskSet('tasks.bug-recheck 正在复核') // 运行时（task-state 登记，对话删掉时跟着清）：正在复核的对话，重启后下一轮结束时重跑

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

/** 跑一条命令：输出按到达顺序拼起来只留最后一段 */
export async function runOnce(command: string, cwd: string, task?: Task): Promise<RecheckRun> {
  let out = ''
  const add = (s: string) => {
    out += s
    if (out.length > RECHECK_OUT_MAX * 2) out = out.slice(-RECHECK_OUT_MAX)
  }
  const started = Date.now()
  const r = await runShell(command, cwd, {
    shell: await currentShell(),
    timeoutMs: timeoutMs(),
    env: task ? noPushEnv(task) : [],
    onLine: (l) => add(`${l}\n`),
    onStderr: add,
  })
  const ms = Date.now() - started
  return {
    code: r.killed ? null : r.code,
    out: out.slice(-RECHECK_OUT_MAX),
    ms,
    timedOut: r.killed === 'timeout',
    error: r.spawnError ? t('命令没跑起来：{e}', { e: r.spawnError }) : '',
  }
}

/**
 * 改前的代码：对话开始时的提交开一个临时的分离工作区，拷进现在的测试文件，链上依赖目录。
 * 取不到时返回原因（不是 Git 仓库、没记下开始时的提交）
 */
export async function prepareBase(
  dir: string,
  baseRef: string,
  gate: <T>(run: () => Promise<T>) => Promise<T> = (f) => f(),
): Promise<{ path: string; done: () => Promise<void> } | { error: string }> {
  if (!baseRef) return { error: t('对话开始时没有记下提交（不是 Git 仓库？），取不到改前的代码') }
  const ok = await git(dir, ['cat-file', '-e', `${baseRef}^{commit}`]).then(
    () => true,
    () => false,
  )
  if (!ok) return { error: t('找不到对话开始时的提交 {ref}，取不到改前的代码', { ref: baseRef.slice(0, 10) }) }
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'agent-panel-recheck-'))
  const base = path.join(tmp, 'base')
  const links: string[] = []
  const done = async () => {
    // 先拆掉链接再删目录：删目录不能顺着链接删到现在的依赖
    for (const l of links) await unlink(l).catch(() => {})
    await gate(() => git(dir, ['worktree', 'remove', '--force', base])).catch(() => {})
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    await gate(() => git(dir, ['worktree', 'prune'])).catch(() => {})
  }
  try {
    await gate(() => git(dir, ['worktree', 'add', '--detach', base, baseRef]))
    // 现在的测试文件：和开始时比改了的、新加的（没跟踪的）
    const changed = (await git(dir, ['diff', '--name-only', baseRef]).catch(() => ''))
      .split('\n')
      .concat((await git(dir, ['ls-files', '--others', '--exclude-standard']).catch(() => '')).split('\n'))
      .map((x) => x.trim())
      .filter((x) => x && TEST_FILE.test(x))
    for (const f of new Set(changed)) {
      const from = path.join(dir, f)
      if (!(await exists(from))) continue
      await mkdir(path.dirname(path.join(base, f)), { recursive: true })
      await copyFile(from, path.join(base, f))
    }
    for (const name of DEP_DIRS) {
      const from = path.join(dir, name)
      const to = path.join(base, name)
      if (!(await exists(from)) || (await lstat(to).catch(() => null))) continue
      await symlink(from, to, 'junction')
      links.push(to)
    }
    return { path: base, done }
  } catch (e) {
    await done()
    return { error: t('开改前的临时工作区失败：{e}', { e: (e as Error).message.split('\n')[0] }) }
  }
}

/** 跑完整的一次复核：改前（临时工作区）和改后（现在的目录）各跑一遍 */
export async function recheck(
  task: Task,
  d: Diagnosis,
  dir: string,
  gate?: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<Recheck> {
  const at = new Date().toISOString()
  const items: Recheck['items'] = recheckCommands(d).map((command) => ({
    command,
    skip: ranInConversation(command, task.messages) ? '' : t('这条命令没在对话里跑过，面板不替它跑'),
  }))
  if (!dir) return { state: 'skipped', why: t('找不到对话的工作目录'), at, items }
  const todo = items.filter((x) => !x.skip)
  if (!todo.length) return { state: 'done', why: '', at, doneAt: new Date().toISOString(), items }
  const base = await prepareBase(dir, task.baseRef, gate)
  try {
    for (const x of todo) {
      x.before =
        'error' in base
          ? { code: null, out: '', ms: 0, timedOut: false, error: base.error }
          : await runOnce(x.command, base.path, task)
      x.after = await runOnce(x.command, dir, task)
    }
  } finally {
    if (!('error' in base)) await base.done()
  }
  return { state: 'done', why: '', at, doneAt: new Date().toISOString(), items }
}

type Scope = Pick<TasksScope, 'taskDir' | 'store' | 'live' | 'wakeConv' | 'gitGate'>

/** 现在的那一份任务：在跑的以内存里的为准 */
async function current(sc: Scope, id: string): Promise<{ task: Task; bump: () => void } | undefined> {
  const e = sc.live.get(id)
  if (e) return { task: e.task, bump: () => e.rev++ }
  const task = await sc.store.get(id)
  return task ? { task, bump: () => {} } : undefined
}

/**
 * 子对话这一轮结束时调（server/tasks/run.ts 的 onTurnEnd）：最新一版是要复核的修复 / 验证就跑，
 * 跑完记进报告；用户开着自动通过的，按结果决定这一版通不通过
 */
export async function afterTurnRecheck(sc: Scope, taskId: string, newId: () => string) {
  const first = await current(sc, taskId)
  const d0 = first?.task.bug?.diagnoses?.at(-1)
  if (!first || !d0 || running.has(taskId)) return
  const stale = d0.recheck?.state === 'running'
  if (!needsRecheck(d0) && !stale) return
  running.add(taskId)
  try {
    const version = d0.version
    d0.recheck = {
      state: 'running',
      why: '',
      at: new Date().toISOString(),
      items: recheckCommands(d0).map((command) => ({ command, skip: '' })),
    }
    first.bump()
    await sc.store.update(taskId, first.task)
    const dir = await sc.taskDir(first.task).catch(() => '')
    const result = await recheck(first.task, d0, dir, sc.gitGate).catch((e): Recheck => ({
      state: 'skipped',
      why: t('复核出错：{e}', { e: (e as Error).message }),
      at: new Date().toISOString(),
      items: [],
    }))
    // 跑的这段时间里任务可能落过盘、换过对象：按顺序号找回那一版再写
    const now = await current(sc, taskId)
    const d = now?.task.bug?.diagnoses?.find((x) => x.version === version)
    if (!now || !d) return
    d.recheck = result
    const list = now.task.bug?.diagnoses ?? []
    const fix = phaseOf(d) === 'fix' && d === list.at(-1) && d.status === 'pending'
    const gate =
      fix && autoOn(list)
        ? autoBlock(
            d,
            list,
            (now.task.changes ?? []).map((x) => x.path),
          )
        : undefined
    let feedback = ''
    const at = new Date().toISOString()
    if (gate?.ok) {
      const a = autoApprove(d, at)
      now.task.messages.push(bugLine(newId(), version, a.line, at))
      feedback = a.feedback
    } else if (gate && !gate.ok && gate.why)
      now.task.messages.push(
        bugLine(newId(), version, t('第 {n} 版没有自动通过：{why}', { n: revOf(d), why: gate.why }), at),
      )
    now.bump()
    await sc.store.update(taskId, now.task)
    // 自动通过：把用户同意时的那段话交给它接着做（面板替用户点的，记成面板的说明，不冒充用户说的话）
    if (feedback) await sc.wakeConv(taskId, feedback, { panel: 'note' })
  } finally {
    running.delete(taskId)
  }
}

const bugLine = (id: string, version: number, text: string, at: string) => ({
  id,
  role: 'system' as const,
  agentId: '',
  step: '',
  text,
  tools: [],
  bugReport: version,
  at,
})

/** run.ts 里一行调用：出错只记日志（复核是附加的核对，不能挡住一轮的收尾） */
export const recheckAfterTurn = (sc: Scope, taskId: string, newId: () => string) =>
  void afterTurnRecheck(sc, taskId, newId).catch((e) =>
    log.warn('task', '复核回归测试失败', { task: taskId, error: (e as Error).message }),
  )
