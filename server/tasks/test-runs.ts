import { Task, type TaskTestRun, type TestStep } from '../../shared/schema.ts'
import { createParentTests, parentTestFailText, parentTestRun } from '../parent-tests.ts'
import {
  currentTestSteps,
  matchTestStep,
  mergeTestRun,
  parentRunSteps,
  pickSteps,
  stepCommand,
  testRunLines,
} from '../../shared/test-steps.ts'
import { jobMs, type BgJob } from '../background.ts'
import { log } from '../log.ts'
import { markWrapUp } from '../../shared/plan.ts'
import type { TasksScope } from './scope.ts'

/**
 * 测试步骤：父对话代跑子对话的测试（ADR 0018 / 0020）、记录测试结果、重启后接着等还没出结果的测试。
 */
export function createTestRuns(sc: TasksScope) {
  /** 父对话替子对话申请的编译（后台命令编号 → 申请的子对话）：结果出来时也推给它们 */
  const buildFor = new Map<string, { parent: string; children: string[] }>()

  /**
   * 父对话测试（ADR 0018 / 0020）：子对话合回后，面板在父对话目录里按顺序跑范围为 parent 的步骤（全量单测、全量界面检查、e2e）。
   * 一次只跑一批的一步：多个子对话同时合并时重测试（WSL e2e 这类）排成一条队，不并着抢机器；
   * 后台命令本身还走父对话目录的独占队列，和 UE 编译这类同样吃资源的命令共用一条队。
   * 成功才让子对话收尾（标完成、删分支），失败把报错和来源交回它修。
   */
  const parentTests = createParentTests({
    start: async ({ run, step, name }) => {
      const child = await sc.current(run.childId)
      const parent = await sc.current(run.parentId)
      if (!child || !parent) return { ok: false, info: '这个子对话或父对话已经不在了，这批测试没有跑。' }
      const project = child.projectId ? await sc.deps.projects.get(child.projectId) : null
      const r = sc.background.start({
        taskId: parent.id,
        name,
        command: stepCommand(step, child.platform || process.platform, project?.wslDistro ?? ''),
        cwd: step.cwd,
        root: await sc.taskDir(parent),
        // 和编译共用一条独占队：同一目录同一时间只跑一条，UE 编译跑着时新测试排在后面
        exclusive: true,
        ...(step.timeoutSec ? { timeoutMinutes: Math.max(1, Math.ceil(step.timeoutSec / 60)) } : {}),
      })
      if (!r.ok) return { ok: false, info: r.info }
      return { ok: true, id: r.id! }
    },
    record: async (run, step, done) => {
      await recordTestRun(run.childId, parentTestRun(step, done, new Date().toISOString()))
    },
    pass: async (run) => {
      const tk = await sc.current(run.childId)
      if (!tk) return
      const parent = await sc.current(run.parentId)
      const lines = testRunLines(tk.testRuns)
      await sc.childMerged(
        run.childId,
        `【父对话测试通过】父对话在它自己的目录里跑完了范围为「全量，合并后由父对话跑」的步骤（耗时是面板按后台命令的真实起止时间记的）：\n${lines.join('\n') || '（没有记录）'}\n已合回原分支，收尾完成。收尾总结里要有一份「编译 / 测试耗时」：照上面的行写，再加上你自己跑过的步骤（看后台命令结果里的用时）；没跑过的不写，没有记录的写「未记录」，不要编数字。`,
        parent ? { peer: await sc.peerOf(parent, 'parent', 'test', `父对话测试通过：${run.childTitle}`) } : {},
      )
    },
    fail: async (run, failed) => {
      const tk = await sc.current(run.childId)
      if (!tk?.wrapRequest) return
      const failedText = parentTestFailText(failed)
      // 报错原文只留前面一段：它会随任务存盘，父对话读到的也只有第一行
      const info = failedText.length > 4000 ? `${failedText.slice(0, 4000)}…` : failedText
      // 用单独的状态：'failed' 的语义是「没合进去」，这里分支已经合回、只是测试没过，两侧的说明完全不同（评审 R3）
      tk.wrapRequest = { ...tk.wrapRequest, state: 'test-failed', info }
      markWrapUp(tk, 'merge', 'running', `父对话测试没通过：第 ${failed.index + 1} 步「${failed.step.name}」`)
      tk.updatedAt = new Date().toISOString()
      const entry = sc.live.get(tk.id)
      if (entry) entry.rev++
      await sc.store.update(tk.id, tk)
      // 失败要重新上报一次：状态从「待收尾」变成「未完成」，父对话计划里等它那步要跟着改说法
      sc.reportedState.delete(tk.id)
      const lines = testRunLines(tk.testRuns)
      await sc.sendToChild(
        run.parentId,
        run.childId,
        `【父对话测试未通过】来自子对话「${run.childTitle}」（id ${run.childId}）：你的分支已经合回，但父对话在它的目录里跑这条步骤时失败了，下面是它的报错。\n${failedText}\n${lines.length ? `已记录的耗时：\n${lines.join('\n')}\n` : ''}你的独立分支还在：按报错修好、在你的分支里重新跑通其它检查后调用 submit_merge；合回去时面板会把这些步骤全部重跑一遍（跑过也不跳过），通过才收尾。`,
        'build',
        'test',
        true,
      )
    },
    // 起命令期间这一批被取消（丢弃独立分支）：把刚起来的那条命令停掉
    stop: (run, jobId) => {
      sc.background.stopOne(run.parentId, jobId)
    },
    onError: (where, error) => {
      log.warn('task', '父对话测试推进失败', { where, error: error.message })
    },
  })

  /** 记一步测试的耗时：同一条步骤 + 同一个执行方只留最后一次，tries 累加（见 mergeTestRun） */
  async function recordTestRun(taskId: string, run: Omit<TaskTestRun, 'tries'>) {
    const entry = sc.live.get(taskId)
    const tk = entry?.task ?? (await sc.store.get(taskId))
    if (!tk) return
    tk.testRuns = mergeTestRun(tk.testRuns, run)
    tk.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    await sc.store.update(tk.id, tk)
  }

  /**
   * 子对话自己跑的项目测试步骤也记耗时：收尾总结里它和父对话跑的那几行能放在同一张表里对齐。
   * 只认能对应到项目测试步骤的后台命令（matchTestStep），Agent 自己拼的查看命令不记；
   * 耗时用后台命令的真实起止时间，不靠 Agent 自报
   */
  async function recordSelfTestRun(job: BgJob) {
    const tk = await sc.current(job.taskId)
    if (!tk) return
    const project = tk.projectId ? await sc.deps.projects.get(tk.projectId) : null
    const step = matchTestStep(
      await testStepsOf(tk),
      job.command,
      tk.platform || process.platform,
      project?.wslDistro ?? '',
    )
    if (!step) return
    await recordTestRun(tk.id, {
      stepId: step.id,
      stepName: step.name,
      by: 'self',
      ok: job.state === 'done',
      durationMs: jobMs(job),
      at: new Date().toISOString(),
    })
  }

  /**
   * 合回成功、要由父对话跑测试时：把子对话记成「等父对话测试」，再把这一批排进队列。
   * 不调用 childMerged：那一步会把计划里的收尾标完成、清掉 wrapRequest、收口删分支——
   * 父对话测试没通过之前，这些都不能做
   */
  async function startParentTests(tk: Task, steps: TestStep[]) {
    if (!tk.parentTaskId || !tk.wrapRequest) return
    tk.wrapRequest = { ...tk.wrapRequest, state: 'testing', info: '' }
    markWrapUp(tk, 'merge', 'waiting', `已合回，等父对话跑测试：${steps.map((s) => s.name).join('、')}`)
    tk.updatedAt = new Date().toISOString()
    const entry = sc.live.get(tk.id)
    if (entry) entry.rev++
    await sc.store.update(tk.id, tk)
    parentTests.enqueue({ parentId: tk.parentTaskId, childId: tk.id, childTitle: tk.title, steps })
  }

  /**
   * 这个子对话要由父对话跑的步骤：以项目当前设置为准（调用前现读），任务快照只在项目被删、
   * 读不到时兜底——和 parentRunRole 的判断、提示词里的步骤是同一份来源，不然提示词说「父对话会跑」、
   * 执行时却一条都跑不了。
   */
  async function testStepsOf(tk: Task) {
    // 读项目失败（文件被占 / 写坏 / 权限）不能默默当成「项目不存在」：那会退回旧快照、把用户刚改的设置
    // 当成没生效，现象和这个 bug 一模一样还没痕迹。先留一条 warning 再兜底，子对话合并不因此失败
    const project = tk.projectId
      ? await sc.deps.projects.get(tk.projectId).catch((e) => {
          log.warn('task', '读项目失败，按任务快照判断测试步骤', {
            task: tk.id,
            project: tk.projectId,
            error: (e as Error).message,
          })
          return null
        })
      : null
    return currentTestSteps(tk.testSteps, project)
  }

  /** 这个子对话要由父对话跑的步骤（见 parentStepsOf 的说明） */
  const parentStepsOf = async (tk: Task) => parentRunSteps(await testStepsOf(tk))

  /**
   * 父对话合并后真正要排进队列的步骤：在 parentRunSteps 的基础上按子对话的实际改动筛（stepApplies）。
   * 一条都没命中就是这批改动不涉及这些步骤，不跑；子对话的改动清单取不到（空）时 pickSteps 会返回全部，
   * 那是「不知道改了什么」，保守地跑
   */
  const parentTestStepsOf = async (tk: Task) =>
    pickSteps(
      await parentStepsOf(tk),
      tk.changes.map((c) => c.path),
    ).run

  /** 这个子对话是否在等父对话测试：任务上的状态（重启后还在）+ 内存里的队列 */
  const parentTesting = (childId: string, tk: Pick<Task, 'wrapRequest'>) =>
    tk.wrapRequest?.state === 'testing' || parentTests.statusOf(childId) !== ''

  /**
   * 面板重启后把没跑完的父对话测试重新排队（ADR 0018）：批次记在任务上（wrapRequest.state = testing），
   * 内存里的队列随进程没了。从第一步重跑一遍——比丢掉安全，测试本身可以重复跑
   */
  async function recoverParentTests() {
    for (const raw of await sc.store.list()) {
      if (raw.archived || raw.wrapRequest?.state !== 'testing') continue
      const tk = sc.live.get(raw.id)?.task ?? raw
      if (!tk.parentTaskId) {
        tk.wrapRequest = undefined
        await sc.store.update(tk.id, tk)
        continue
      }
      const steps = await parentTestStepsOf(tk)
      if (!steps.length) {
        await sc
          .childMerged(tk.id, '【父对话测试】项目里已经没有要由父对话跑的测试步骤了，直接收尾。')
          .catch((e) => log.warn('task', '没有父对话测试步骤时收尾失败', { task: tk.id, error: (e as Error).message }))
        continue
      }
      await startParentTests(tk, steps)
      log.info('task', '重启后重新排队父对话测试', {
        task: tk.id,
        parent: tk.parentTaskId,
        steps: steps.map((s) => s.name),
      })
    }
  }

  return {
    buildFor,
    parentTestStepsOf,
    parentTesting,
    parentTests,
    startParentTests,
    recordSelfTestRun,
    recoverParentTests,
  }
}
