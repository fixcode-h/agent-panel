/**
 * 停在等下一句的 CLI 进程还配不配得上现在的选择：从 runner.ts 拆出来（文件行数上限，见 docs/lessons/file-caps.md）。
 * 对不上时保活的进程不再接消息，这一轮结束后按新的选择重开
 */
import type { Agent, Settings, Task } from '../../shared/schema.ts'
import { agentRun } from '../../shared/settings.ts'
import { withTaskModel } from '../../shared/tasks/run.ts'
import { replyLang } from '../../shared/prompt-lang.ts'
import { taskLog } from '../task-log.ts'

export function makeStillCurrent(a: {
  task: Task
  found: Agent
  settings: Settings
  cliId: string
  model: string
  cwd: string
}) {
  const { task, found, settings, cliId, model, cwd } = a
  // 启动这一轮时的选择；执行中换了 CLI/模型/强度，或者面板语言变了（系统提示词和 mod 的环境变量固定在
  // 这个进程里，新消息的提醒却是新语言），结束时都不能还停在旧进程上等下一句
  const startPick = { cli: task.cli, model: task.model, effort: task.effort, lang: replyLang() }
  const startBug = String(task.bug?.kind === 'report')
  return () => {
    const now = agentRun(withTaskModel(found, task), settings)
    // 这一轮里开了独立分支：进程还在原目录里，不能再等下一句，结束后在新目录里重开
    const wt = task.worktree?.state === 'active' ? task.worktree.path : ''
    const diff = [
      ['cli', cliId, now.cli],
      ['model', model, now.model],
      ['effort', startPick.effort, task.effort],
      ['lang', startPick.lang, replyLang()],
      ['cwd', cwd, wt || cwd],
      // 用户在子对话里发了 /bug：标成用户报的 Bug 后要有 submit_diagnosis，旧进程的工具列表里没有，重开
      ['bug', startBug, String(task.bug?.kind === 'report')],
    ].filter(([, was, is]) => (was ?? '') !== (is ?? ''))
    // 对不上就会结束这个进程、按现在的选择重开：记下是哪一项、前后各是什么，偶发重开时诊断文件里能直接看出原因
    if (diff.length)
      taskLog(
        task.id,
        '等下一句的 CLI 和现在的选择对不上',
        Object.fromEntries(diff.map(([k, a, b]) => [k, `${a} → ${b}`])),
      )
    return !diff.length
  }
}
