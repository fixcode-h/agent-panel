import type { TaskTestRun, TestStep } from '../shared/schema.ts'
import { fmtDuration } from '../shared/duration.ts'
import { t } from '../shared/i18n.ts'

/**
 * 范围是 parent 的测试步骤（全量单测、全量界面检查、e2e，见 ADR 0018 / 0020）：子对话合并后，面板在父对话目录里按顺序跑这些步骤，
 * 把结果和耗时回传给发起的子对话；成功才让它收尾，失败就交回去修。
 *
 * 这一层只管「一批步骤按顺序跑、跑到哪、结果交给谁」，怎么起命令、怎么落盘由调用方注入，
 * 所以能脱离后台队列和任务存储单独跑单测。全局一次只跑一批的一个步骤：多个子对话同时合并时
 * 重测试（WSL e2e 这类）排成一条队，不并着抢机器。后台命令本身还走父对话目录的独占队列，
 * 和 UE 编译这类同样吃资源的命令共用一条队。
 */

/** 一次父对话测试批次：某个子对话合并后要跑的步骤，按项目里配置的顺序 */
export interface ParentTestJob {
  parentId: string
  childId: string
  /** 子对话标题：后台命令名里带上，用户在运行区看得出这是谁的测试 */
  childTitle: string
  steps: TestStep[]
}

export interface ParentTestRun extends ParentTestJob {
  /** 正在跑第几步（0 开始） */
  index: number
  /** 正在跑的那条后台命令；没在跑时为空 */
  jobId: string
}

/** 一条后台命令跑完的结果：耗时和退出状态都取自后台命令本身，不靠 Agent 自报 */
export interface ParentTestDone {
  ok: boolean
  durationMs: number
  /** 输出结尾：失败时回传给子对话 */
  output: string
  /** 命令是被停掉的（用户 / 面板主动停），不是自己跑完的：说明里要写清，不能拿它当测试真的跑过 */
  stopped?: boolean
}

/** 一步失败时告诉调用方失败在哪一步，由它拼「来自哪个子对话」的说法 */
export interface ParentTestFail {
  step: TestStep
  /** 第几步（0 开始，按批次里的顺序） */
  index: number
  /** 这步的真实耗时，失败时收尾总结里也照实写 */
  durationMs: number
  output: string
  /** 见 ParentTestDone.stopped */
  stopped?: boolean
}

export interface ParentTestsDeps {
  /** 起一条后台命令。父对话目录的独占队列由调用方设置，同一目录同一时间只跑一条 */
  start: (input: ParentTestStart) => Promise<{ ok: true; id: string } | { ok: false; info: string }>
  /** 一批全部通过：让子对话收尾（合回已完成，这时才标完成、删分支） */
  pass: (run: ParentTestRun) => Promise<void>
  /** 中途失败或起不来：交回子对话修，别让它收尾 */
  fail: (run: ParentTestRun, failed: ParentTestFail) => Promise<void>
  /** 记一步的耗时：调用方写进子对话的任务记录，重启后收尾总结还能用 */
  record: (run: ParentTestRun, step: TestStep, done: { ok: boolean; durationMs: number }) => Promise<void>
  /**
   * 停掉一条刚起来的后台命令：起命令期间这一批被取消（用户丢弃了独立分支）时用。
   * 不传时只把它记成「结果要吞掉」，命令自己跑完（测试里没有后台队列）
   */
  stop?: (run: ParentTestRun, jobId: string) => void | Promise<void>
  /** 出错时的日志（不吞异常，让调用方记下来） */
  onError?: (where: string, error: Error) => void
}

export interface ParentTestStart {
  run: ParentTestRun
  step: TestStep
  /** 后台命令名：谁在跑、跑的哪一步 */
  name: string
}

export interface ParentTests {
  /** 排进队列；这个子对话已经有一批在排 / 在跑时返回原来那批，不重复排队 */
  enqueue: (job: ParentTestJob) => ParentTestRun
  /** 后台命令跑完：由调用方在结果回调里调；不是这批的命令返回 false */
  finishJob: (jobId: string, done: ParentTestDone) => Promise<boolean>
  /** 某个子对话的批次状态：running / queued / 没有（submit_merge 门禁用它） */
  statusOf: (childId: string) => 'running' | 'queued' | ''
  /**
   * 取消某个子对话的批次（它的独立分支被丢弃时）：排着的移除、正在跑的那条返回给调用方去停，
   * 之后那条命令的结果会被吞掉（不推进、不回传）。
   */
  cancel: (childId: string) => string | undefined
  /**
   * 父对话被停止 / 归档 / 删除（不是面板退出）：面板代它跑的测试命令跟着停了，结果不会再回来。
   * 把正在跑的那批按未通过退回子对话（分支保留、可以重新 submit_merge），别让它永远停在「等父对话测试」。
   * 面板退出时不要调：重启后 recoverParentTests 把还在 testing 的批次重排
   */
  abortByParent: (parentId: string, output: string) => Promise<boolean>
  /** 等手上的事都做完（测试用；调用方也可以不 await） */
  idle: () => Promise<void>
}

/** 后台命令名：谁在跑、跑的哪一步。用户看运行区时要能对上子对话，所以标题写在前面 */
export const parentTestJobName = (childTitle: string, stepName: string) =>
  t('父对话测试：{child} · {step}', { child: childTitle, step: stepName })

/** 失败消息里的一步：第几步、步骤名、用时、输出结尾，交给调用方拼「来自哪个子对话」 */
export function parentTestFailText(failed: ParentTestFail) {
  // 被停掉的命令没跑完：没有真实耗时（可能是排队中被停），写「用时 0s」会误导
  const head = failed.stopped
    ? t('第 {n} 步「{name}」被停止了，没有跑完', { n: failed.index + 1, name: failed.step.name })
    : t('第 {n} 步「{name}」失败，用时 {time}', {
        n: failed.index + 1,
        name: failed.step.name,
        time: fmtDuration(failed.durationMs),
      })
  const why = failed.stopped ? t('这条命令被停止了（不是自己跑完的），结论按未通过处理。') : ''
  const tail = failed.output.trim()
  return [head, why, tail].filter(Boolean).join('\n')
}

export function createParentTests(deps: ParentTestsDeps): ParentTests {
  /** 排着还没开始的批次 */
  const queue: ParentTestRun[] = []
  /** 正在跑的那一批（全局只有一批、一步） */
  let current: ParentTestRun | null = null
  /** 后台命令编号 → 它属于哪一批 */
  const jobs = new Map<string, ParentTestRun>()
  /** 已被取消的批次命令（分支被丢弃）：结果回来时直接吞掉，不推进也不回传给子对话 */
  const canceled = new Set<string>()
  /** 所有推进都串在这一条链上：排队、起下一步、收尾不会交错 */
  let chain: Promise<void> = Promise.resolve()

  const schedule = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((error) => deps.onError?.('parentTests', error as Error))
    return chain
  }

  const find = (childId: string) => (current?.childId === childId ? current : queue.find((r) => r.childId === childId))

  async function startStep(run: ParentTestRun) {
    const step = run.steps[run.index]
    if (!step) return finish(run, { ok: true })
    let started: Awaited<ReturnType<ParentTestsDeps['start']>>
    try {
      started = await deps.start({ run, step, name: parentTestJobName(run.childTitle, step.name) })
    } catch (error) {
      started = { ok: false, info: (error as Error).message }
    }
    if (!started.ok) return finish(run, { ok: false, step, index: run.index, durationMs: 0, output: started.info })
    // 起命令期间这一批被取消了（用户丢弃了独立分支）：命令刚起来，交给调用方停掉，结果吞掉、不推进（评审 R1）
    if (current !== run) {
      canceled.add(started.id)
      await deps.stop?.(run, started.id)
      return
    }
    run.jobId = started.id
    jobs.set(started.id, run)
  }

  async function finish(run: ParentTestRun, result: { ok: true } | ({ ok: false } & ParentTestFail)) {
    if (current !== run) return
    current = null
    run.jobId = ''
    if (result.ok) await deps.pass(run).catch((error) => deps.onError?.('pass', error as Error))
    else
      await deps
        .fail(run, {
          step: result.step,
          index: result.index,
          durationMs: result.durationMs,
          output: result.output,
          ...(result.stopped ? { stopped: true } : {}),
        })
        .catch((error) => deps.onError?.('fail', error as Error))
    await advance()
  }

  async function advance() {
    if (current) return
    const run = queue.shift()
    if (!run) return
    current = run
    await startStep(run)
  }

  /** 没起命令的批次按未通过退回（父对话被停止 / 归档时用）：一步都没跑，不记耗时 */
  async function stopRun(run: ParentTestRun, output: string) {
    const step = run.steps[run.index]
    if (!step) return
    await deps
      .fail(run, { step, index: run.index, durationMs: 0, output, stopped: true })
      .catch((error) => deps.onError?.('fail', error as Error))
  }

  return {
    enqueue(job) {
      const already = find(job.childId)
      if (already) return already
      const run: ParentTestRun = { ...job, index: 0, jobId: '' }
      queue.push(run)
      void schedule(advance)
      return run
    },
    async finishJob(jobId, done) {
      // 取消掉的那条：结果吞掉，不推进队列、不回传给子对话（调用方据此跳过普通后台命令的推送）
      if (canceled.delete(jobId)) return true
      const run = jobs.get(jobId)
      if (!run) return false
      jobs.delete(jobId)
      const step = run.steps[run.index]
      if (!step) return false
      // 这条命令已经结束了：先摘掉 jobId——取消正好落在下面的落盘 / 回传期间时，不需要再停它
      run.jobId = ''
      await schedule(async () => {
        // 收尾期间这一批被取消（分支被丢弃）：不记耗也不再推进下一步（评审 R1）
        if (current !== run) return
        await deps
          .record(run, step, { ok: done.ok, durationMs: done.durationMs })
          .catch((error) => deps.onError?.('record', error as Error))
        // record 是异步落盘，这期间取消的同样要停手：后面会起下一步
        if (current !== run) return
        if (!done.ok) {
          await finish(run, {
            ok: false,
            step,
            index: run.index,
            durationMs: done.durationMs,
            output: done.output,
            ...(done.stopped ? { stopped: true } : {}),
          })
          return
        }
        run.index++
        if (run.index < run.steps.length) await startStep(run)
        else await finish(run, { ok: true })
      })
      return true
    },
    statusOf(childId) {
      if (current?.childId === childId) return 'running'
      return queue.some((r) => r.childId === childId) ? 'queued' : ''
    },
    cancel(childId) {
      const at = queue.findIndex((r) => r.childId === childId)
      if (at >= 0) queue.splice(at, 1)
      if (current?.childId !== childId) {
        void schedule(advance)
        return undefined
      }
      const run = current
      current = null
      const jobId = run.jobId
      run.jobId = ''
      if (jobId) {
        canceled.add(jobId)
        jobs.delete(jobId)
      }
      void schedule(advance)
      // 没拿到编号（还没起命令 / 命令已经结束）时返回 undefined：调用方据此判断不用停
      return jobId || undefined
    },
    /**
     * 父对话被停止 / 归档 / 删除（不是面板退出）：面板代它跑的测试命令跟着停了，结果不会再回来。
     * 跑着的那批和队里排着的一起按未通过退回子对话（分支保留、可以重新 submit_merge）。
     * 只退跑着的那批不够：finish 结尾的 advance 会把队里同父对话的下一批起成新命令，
     * 紧接着被生命周期停静默停掉，那个子对话又会永远停在「等父对话测试」（复看 R3）。
     * 面板退出时不要调：重启后 recoverParentTests 把还在 testing 的批次重排
     */
    async abortByParent(parentId, output) {
      // 先把队里同父对话的批次摘出来：摘完 advance 就不会把她们起成新命令
      const pending = queue.filter((r) => r.parentId === parentId)
      for (const r of pending) {
        const at = queue.indexOf(r)
        if (at >= 0) queue.splice(at, 1)
      }
      const run = current
      const running = !!run && run.parentId === parentId
      // 正在跑那条已经（或马上）被调用方停掉了：先摘编号，别让它被当成还在跑
      if (run && running && run.jobId) {
        canceled.add(run.jobId)
        jobs.delete(run.jobId)
        run.jobId = ''
      }
      if (!pending.length && !running) return false
      await schedule(async () => {
        for (const r of pending) await stopRun(r, output)
        if (!run || !running || current !== run) return
        const step = run.steps[run.index]
        // 兜底：正常不会走到（current 只从 startStep 进来，index 必定有步骤）。也不判通过
        if (!step) {
          current = null
          await advance()
          return
        }
        await finish(run, { ok: false, step, index: run.index, durationMs: 0, output, stopped: true })
      })
      return true
    },
    idle: () => chain,
  }
}

/** 耗时记录的构造：只在这里拼，字段名和 schema 一致（stepId / stepName / by / ok / durationMs） */
export function parentTestRun(
  step: TestStep,
  done: { ok: boolean; durationMs: number },
  at: string,
): Omit<TaskTestRun, 'tries'> {
  return {
    stepId: step.id,
    stepName: step.name,
    by: 'parent',
    ok: done.ok,
    durationMs: Math.max(0, Math.round(done.durationMs)),
    at,
  }
}
