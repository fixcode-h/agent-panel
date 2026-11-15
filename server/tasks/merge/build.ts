import { type Project, type Task } from '../../../shared/schema.ts'
import { buildSkipText, buildSteps, buildStepsFor, currentTestSteps } from '../../../shared/test-steps.ts'
import { stepRun } from '../../step-run.ts'
import { buildKids, buildSig, type BuildAsk } from '../../../shared/build-ask.ts'
import { isolated } from '../helpers.ts'
import type { TasksScope } from '../scope.ts'
import { freshTask, readTask } from '../read.ts'
import { wakeTask } from './wake.ts'

/** 要编译的改动的指纹（见 shared/build-ask.ts）：只算会触发编译的文件；项目没有编译步骤时为空 */
export async function buildSigOf(sc: TasksScope, tk: Task) {
  const project = tk.projectId ? await sc.deps.projects.get(tk.projectId).catch(() => null) : null
  const steps = currentTestSteps(tk.testSteps, project)
  if (!buildSteps(steps).length) return ''
  return buildSig(tk.changes.filter((c) => buildStepsFor(steps, [c.path]).length))
}

/** 改了子对话的编译记录：在跑的改内存里那份（rev++ 让它落盘），没在跑的直接写盘 */
export async function saveBuildAsk(sc: TasksScope, tk: Task, ask: BuildAsk) {
  tk.buildAsk = ask
  const entry = sc.live.get(tk.id)
  if (entry) entry.rev++
  await sc.store.update(tk.id, tk)
}

/**
 * 这批改动用不用编译（按文件类型，见 buildStepsFor）：不用时返回跟 Agent 说的原因，要编译返回空串。
 * 读不到项目、项目里没配编译步骤、改动清单取不到时都按要编译算——那是「不知道」，交给父对话按原流程处理
 */
export async function buildSkip(sc: TasksScope, tk: Task, files: string[]) {
  if (!files.length) return ''
  const project = tk.projectId ? await sc.deps.projects.get(tk.projectId).catch(() => null) : null
  const steps = currentTestSteps(tk.testSteps, project)
  if (!buildSteps(steps).length || buildStepsFor(steps, files).length) return ''
  return buildSkipText(steps, files)
}

/**
 * UE 项目的编译归父对话（见 EngineHost.ueBuild）：子对话的申请交给父对话马上处理，
 * 什么时候编、几个申请合成一次由父对话决定，它再向面板占位
 */
async function askParentBuild(sc: TasksScope, child: Task, note: string, checks = '') {
  if (!child.parentTaskId) return
  await wakeTask(
    sc,
    child.parentTaskId,
    child,
    `【编译申请】子对话「${child.title}」（id ${child.id}）申请 UE 编译：${note}${checks ? `\n它做过的检查：${checks.slice(0, 400)}` : ''}
按申请处理：还有别的子对话的申请没编时合成一次，用 request_build 向面板申请编译，children 写上这些子对话的 id；编译结果面板会同时推给你和它们，失败时它们自己修好再申请。`,
    {
      panel: 'wrapup',
      child: { id: child.id, title: child.title, state: 'waiting' },
      peer: await sc.peerOf(child, 'child', 'build', `申请 UE 编译：${note}`),
    },
  )
}

export async function childRequestBuild(
  sc: TasksScope,
  child: Task,
  note: string,
): Promise<{ ok: boolean; info: string }> {
  if (!child.parentTaskId) return { ok: false, info: '只有子对话向父对话申请编译' }
  if (isolated(child))
    return {
      ok: false,
      info: '你在独立分支里，改动要先合回父对话的目录才编得到：调用 submit_merge（build 保持 true），合进去后面板替你向父对话申请编译。',
    }
  const skip = await buildSkip(
    sc,
    child,
    child.changes.map((c) => c.path),
  )
  if (skip) return { ok: true, info: `没有申请编译：${skip}` }
  // 记下申请（会落盘）：父对话漏写 children 时面板按它补上，结果按它推回，submit_merge 也按它核对（见 shared/build-ask.ts）
  await saveBuildAsk(sc, child, {
    state: 'asked',
    at: new Date().toISOString(),
    note,
    sig: await buildSigOf(sc, child),
    jobs: [],
    info: '',
  })
  await askParentBuild(sc, child, note)
  return {
    ok: true,
    info: '已向父对话申请编译。现在可以结束这一轮，编译结果出来面板会直接推给你；报错就修好再申请，通过了再接着做（合并前的验证以这次编译结果为准）。',
  }
}

/**
 * 父对话向面板申请编译：编译是占位的资源，交给后台命令的独占队列，按编译目录排队，
 * 同一目录同一时间只编译一次；各自 worktree 的目录是不同的队，不互相占位。
 * 目录被别的父对话占着时告诉申请方占着的是谁，也告诉占着的一方后面有人在等
 */
export async function parentRequestBuild(
  sc: TasksScope,
  parent: Task,
  project: Project,
  note: string,
  /** 申请这次编译的子对话：结果同时推给它们，不用父对话转述 */
  children: string[] = [],
  /**
   * 父对话用 run_background 交来的编译命令（后台命令重新设计，2026-11-12）：不拒收，按同一个编译目录占位排队，
   * 跑交来的这条命令，不跑项目测试步骤。Agent 按设置里的 shell 写的命令，照旧用那个 shell 跑
   */
  custom?: { name: string; command: string; cwd: string; timeoutMinutes?: number },
): Promise<{ ok: boolean; info: string; id?: string }> {
  if (!custom && !buildSteps(project.testSteps).length)
    return {
      ok: false,
      info: '项目测试步骤里没有编译步骤（勾「合并时编译」或名字带「编译」的）：请用户在项目设置 → 测试步骤里补上，补好之前不要自己拼命令编译。',
    }
  // 为子对话申请时按它们的改动筛编译步骤：只改了 Lua、配置、表格的不编 C++。
  // 不带子对话（用户要求、父对话自己改的）时照常编；子对话的改动清单都取不到时也照常编
  const all = (await sc.store.list()).map((x) => freshTask(sc, x))
  // 父对话漏写 children（或写成 child）时，按「名下申请过、还没开编」的子对话补上：结果能不能回到子对话不再全看模型填没填
  const [to, added] = buildKids(all, parent.id, children)
  const kidFiles = [
    ...new Set(all.filter((x) => to.includes(x.id)).flatMap((x) => freshTask(sc, x).changes.map((c) => c.path))),
  ]
  const steps = custom ? [] : to.length ? buildStepsFor(project.testSteps, kidFiles) : buildSteps(project.testSteps)
  if (!custom && !steps.length) {
    // 不用编译也是结果：记成通过，它们的 submit_merge 核对能过
    for (const tk of all.filter((x) => to.includes(x.id)))
      await saveBuildAsk(sc, tk, {
        state: 'passed',
        at: new Date().toISOString(),
        note: tk.buildAsk?.note ?? note,
        sig: await buildSigOf(sc, tk),
        jobs: [],
        info: '改动不涉及要编译的文件',
      })
    return {
      ok: true,
      info: `没有编译：${buildSkipText(project.testSteps, kidFiles)}告诉申请的子对话（${to.join('、')}）不用等编译，接着收尾。`,
    }
  }
  const dir = await sc.taskDir(parent)
  // 先看占着的再排：排进去以后自己的也算在里面
  const before = sc.background.occupants(dir)
  const ids: string[] = []
  const runs = custom
    ? [{ name: custom.name, command: custom.command, cwd: custom.cwd, timeoutMinutes: custom.timeoutMinutes }]
    : await Promise.all(
        steps.map(async (st) => ({
          name: st.name,
          // 按步骤自己的环境直接起进程，不再包一层字符串交给设置里的 shell（server/step-run.ts）
          ...(await stepRun(st, process.platform, project.wslDistro)),
          cwd: st.cwd,
          timeoutMinutes: undefined as number | undefined,
        })),
      )
  for (const x of runs) {
    const r = sc.background.start({
      taskId: parent.id,
      ...x,
      name: x.name.startsWith('UE 编译') ? x.name : `UE 编译：${x.name}`,
      root: dir,
      exclusive: true,
      // 编译结果只报状态，失败带日志路径（用户 2026-11-15 要求，ADR 0067）
      brief: true,
    })
    if (!r.ok) return { ok: false, info: r.info }
    ids.push(r.id!)
  }
  // 结果也推给申请的子对话：记在它们的任务上（会落盘），编译跑完按这份记录推回（server/tasks/jobs.ts）
  for (const tk of all.filter((x) => to.includes(x.id)))
    await saveBuildAsk(sc, tk, {
      state: 'building',
      at: new Date().toISOString(),
      note: tk.buildAsk?.note ?? note,
      sig: tk.buildAsk?.sig || (await buildSigOf(sc, tk)),
      jobs: ids,
      info: '',
    })
  const queuedMine = before.filter((j) => j.taskId === parent.id).length
  const holders: Task[] = []
  for (const id of new Set(before.map((j) => j.taskId).filter((x) => x !== parent.id))) {
    const tk = await readTask(sc, id)
    if (tk) holders.push(tk)
  }
  // 占着的是别的父对话：告诉它后面有人在等（不叫醒它，执行中就实时送达，空闲就放进收件箱）
  for (const h of holders.filter((x) => !x.parentTaskId))
    await sc.noteParent(
      h.id,
      parent,
      `【编译占位】父对话「${parent.title}」（id ${parent.id}）申请了编译（${note.slice(0, 200)}），排在你占着的编译后面，你的编译跑完它会自动开始。你还要连着编、或者需要它等你的改动时，用 message_peer 告诉它。`,
      undefined,
      undefined,
      undefined,
      await sc.peerOf(parent, 'peer', 'build', `排在你后面等编译：${note}`),
    )
  const who = holders.map((x) => `「${x.title}」`).join('、')
  return {
    ok: true,
    id: ids.at(-1),
    info: [
      `已申请编译（${runs.map((x) => x.name).join('、')}），编号 ${ids.join('、')}。`,
      added.length
        ? `children 没写，面板按申请补上了：${all
            .filter((x) => added.includes(x.id))
            .map((x) => `「${x.title}」（id ${x.id}）`)
            .join('、')}，编译结果会推给它们。`
        : '',
      who
        ? `这个编译目录现在被${who}占着，你排在后面${holders.some((x) => !x.parentTaskId) ? '，已告诉对方' : ''}。`
        : queuedMine
          ? `你前面还有 ${queuedMine} 条自己的编译在排队。`
          : '编译目录空闲，马上开始。',
      to.length
        ? `结果会推回给你，也会直接推给申请的子对话（${to.join('、')}）；等的时候接着处理别的消息，不要另外跑编译。`
        : '结果会推回给你；等的时候接着处理别的消息，不要另外跑编译。',
    ].join(''),
  }
}
