import { bugOf } from '../../../shared/bug/task-bug.ts'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { coreDefinition } from '../../../shared/builtin/core.ts'
import { BUG_RECORD_ASK } from '../../../shared/builtin/bug-method.ts'
import { bugRecordDraft, diagnosisGate } from '../../../shared/bug/diagnosis.ts'
import { fixBriefMd, fixBriefMissing, fixBriefOf, fixBriefPrompt } from '../../../shared/bug/fix-brief.ts'
import { projectChanges } from '../../exec/file-events.ts'
import { clipWithFile } from '../inbox-file.ts'
import { randomUUID } from 'node:crypto'
import { branchCommits, gitNumstat } from '../../exec/git.ts'
import { type HandoffInput, handoffMissing, handoffTemplate, handoffText } from '../../../shared/handoff.ts'
import {
  overrideText,
  reviewGate,
  triageText,
  type ReviewOverride,
  type TriageItem,
} from '../../../shared/review/gate.ts'
import { placedFiles } from '../../attachments.ts'
import { commitWorktree } from '../../exec/worktree.ts'
import { buildGate } from '../../../shared/build-ask.ts'
import { activePlan, markChildWrapUp, openWork } from '../../../shared/plan/index.ts'
import { shrinkClaims } from '../../claims.ts'
import { isolated } from '../helpers.ts'
import { awaitedJob } from '../../background.ts'
import type { MergeCtx } from './context.ts'
import { buildSigOf, buildSkip } from './build.ts'
import { recheckWrapUp, wakeTask } from './wake.ts'

/**
 * 子对话只剩合回时请父对话收尾（ADR 0005）：子对话这边能做的都做完了——计划除了合回都做完、
 * 后台命令都结束、没有等用户 / 父对话回答的提问、编译测试在自己的分支里跑通（tests 写明）。
 * 面板先把现在的改动提交到它的分支，记下收尾请求，计划最后一步标「等待中」，再把请求交给父对话马上处理；
 * 合并、改计划、删分支都由父对话调用 finish_child 发起（面板做 git 操作，父对话决定什么时候收）。
 * 合并就是验收：所以测试必须在这之前、在子对话自己的分支里做完
 */
export async function submitMerge(
  ctx: MergeCtx,
  childId: string,
  note: string,
  tests: string,
  /** UE 项目：合回去后父对话要接着编译（独立分支里编不了 UE，见 ADR 0004） */
  build = false,
  /** 交接要点（见 ADR 0007）：以后再被叫醒、上下文又大时只带这份摘要 */
  handoff: HandoffInput = {},
  /** 对最近一次评审每条高级、中级意见的处置（见 ADR 0009）：门禁按它放行，原样交给父对话验收 */
  triage: TriageItem[] = [],
  /**
   * 显式放行（见 shared/review/gate.ts）：评审没过而用户明确要求「已知问题也合并」时带上。
   * 只有门禁真的拦下时它才生效；生效后记录会写在任务上、并随收尾消息交给父对话
   */
  override?: ReviewOverride,
): Promise<{ ok: boolean; info: string }> {
  const { sc, merging, mergeNudged } = ctx
  const entry = sc.live.get(childId)
  const tk = entry?.task ?? (await sc.store.get(childId))
  if (!tk?.parentTaskId) return { ok: false, info: '只有子对话能请父对话收尾' }
  // 共用父对话目录的子对话（P4、没有版本管理、项目设成共用目录）：没有分支要合，但下面的校验一条不少，
  // 评审、测试、交接、父对话验收是交付的必备步骤，不跟着版本管理方式变（用户 2026-10-31 定的）
  const own = isolated(tk)
  // 合并就是验收：没写跑了什么就不收，免得没验证的改动进了父对话的分支
  if (!tests)
    return {
      ok: false,
      info: '没有请求收尾：tests 里写上你在独立分支里跑了哪些编译、测试和结果。没跑通就先修好再调用；这次确实不需要测试（只改了文档、注释）时写明原因。',
    }
  // 父对话派来的 Bug（ADR 0045）：要有用户确认过的方案，实际改动不超出方案里的文件
  // 面板临时目录里的文件不算项目改动（以前被钩子拦下的写入也记进了改动清单，见 exec/file-events.ts）
  const dir = await sc.taskDir(tk)
  const owned = projectChanges(tk.changes, dir)
  const diag = diagnosisGate(
    tk,
    owned.map((c) => c.path),
  )
  if (diag) return { ok: false, info: diag }
  // 用户报的 Bug（ADR 0046）：[排查-…] 临时日志清掉才收尾（文档里提到这个前缀的不算）
  if (tk.bug?.kind === 'report') {
    const left: string[] = []
    for (const c of owned.filter((x) => !x.path.endsWith('.md'))) {
      const body = await readFile(path.join(dir, c.path), 'utf8').catch(() => '')
      if (body.includes('[排查-')) left.push(c.path)
    }
    if (left.length)
      return {
        ok: false,
        info: `没有请求收尾：这些文件里还有 [排查-…] 临时日志：${left.join('、')}。删掉（确实要留的按项目的日志规范改写）再收尾。`,
      }
  }
  // 后台还在跑的命令多半就是测试：没跑完就不算跑通，合进去后回收分支还会把它掐掉
  const pending = sc.background.list(childId).filter(awaitedJob)
  if (pending.length)
    return {
      ok: false,
      info: `没有请求收尾：后台还有命令没跑完（${pending.map((j) => `「${j.name}」`).join('、')}）。等结果推回来、确认通过后再调用 submit_merge。`,
    }
  // 合回已完成、父对话在跑范围为 parent 的步骤（ADR 0018 / 0020）：等它跑完，不能重复请求
  if (sc.parentTesting(childId, tk))
    return {
      ok: false,
      info: '没有请求收尾：你的分支已经合回，父对话正在跑范围为「全量，合并后由父对话跑」的步骤。结果推回来时：通过就自动标完成、删分支；失败按报错修好再调用 submit_merge。',
    }
  if (tk.requests.length || tk.parentAsks?.length)
    return {
      ok: false,
      info: '没有请求收尾：还有等用户或父对话回答的提问。等回答回来、按回答处理完再调用 submit_merge。',
    }
  const left = openWork(tk)
  if (left.length)
    return {
      ok: false,
      info: `没有请求收尾：计划还有步骤没做完（${left
        .slice(0, 5)
        .map((x) => `${x.id}「${x.title}」`)
        .join('、')}）。做完并用 set_plan 标完成；确实不做的从计划里删掉并说明原因，再调用 submit_merge。`,
    }
  // 合回前必须先评审：收尾流程是 改完 → 快速检查 → 评审（计划里的独立步骤） → 按意见改 → 完整测试 → submit_merge，
  // 评审就是一次普通的 spawn_agents，结论从它的输出里读（见 shared/review/gate.ts）。
  // 子任务是按 id 或名字找角色的：用户自己建了同名的「评审」时，派出去的可能是那个，所以名字也认
  const reviewerName = coreDefinition('reviewer').agent.name
  // 读不到角色列表时单独说明：兜底成空数组会让门禁报「还没有真的派过评审」，把模型引向重复派评审
  const known = await sc.deps.agents.list().catch(() => null)
  if (!known) return { ok: false, info: '没有请求收尾：读取角色列表失败，稍后再试一次。' }
  // 改过文件才要评审：独立分支是 begin_edit 要改文件时才开的，开了就算交付代码；
  // 共用目录看这个对话记下的改动（Git 按差异算，P4 和没有版本管理时按 CLI 报的写文件）。只读排查不用评审
  const review =
    (own || tk.changes.length > 0) &&
    reviewGate(
      tk.steps,
      (id) => known.some((a) => a.id === id && (a.origin === 'builtin:reviewer' || a.name === reviewerName)),
      activePlan(tk)?.steps ?? [],
      triage,
      override,
    )
  if (review && !review.ok) return review
  // 放行记录的时间由面板记：调用方自报的时间挡不住「先传一个过去的时间」。
  // 这里只算出来、先不写回任务：后面还有几步校验，被拒时不留下一条没发起过收尾的「已放行」
  const bypass = review && review.bypass ? { ...review.bypass, at: new Date().toISOString() } : undefined
  // 只认内存里的 merging：记录上的 merging 可能是合并途中面板重启、或旧版本没清掉留下的
  if (merging.has(childId)) return { ok: false, info: '父对话正在合并你的分支，等结果推回来。' }
  // 共用目录的 UE 子对话（ADR 0004）：改了要编译的文件，就要有这次改动的编译通过结果才能请父对话验收。
  // 面板侧的硬约束：提示词里说了「编译通过再 submit_merge」，模型照样会申请完编译就顺手交收尾，
  // 交了之后父子两边都以为对方会动，子对话一直停在「待收尾」（用户 2026-11-04 报）
  if (build && !own) {
    const gate = buildGate(tk.buildAsk, await buildSigOf(sc, tk))
    if (gate) return { ok: false, info: gate }
  }
  // 交接要点放在最后查：前面几样没满足时先修那些，别让它为了写摘要白跑一趟
  const missing = handoffMissing(handoff)
  if (missing.length)
    return {
      ok: false,
      info: `没有请求收尾：handoff 里还缺「${missing.join('、')}」。以后父对话再把消息交给你、上下文又大时，新会话只带这份交接摘要，按下面的模板写（每项写具体路径和结论，不写过程）：\n${handoffTemplate()}`,
    }
  // 直接修的用户 Bug（kind: "fix"，分析稿 B2）：要写根因一句，面板出简版报告
  const noBrief = fixBriefMissing(tk, handoff)
  if (noBrief) return { ok: false, info: noBrief }
  const parentId = tk.parentTaskId
  const wt = own ? tk.worktree! : undefined
  // 先把现在的改动提交到它自己的分支：之后再改的不在这次合并里
  if (wt)
    try {
      await commitWorktree(wt, `Agent 面板：${tk.title}${note ? ` — ${note.slice(0, 60)}` : ''}`)
    } catch (e) {
      return { ok: false, info: `提交到独立分支失败：${(e as Error).message}` }
    }
  mergeNudged.delete(childId)
  const at = new Date().toISOString()
  // 面板补的事实（提交、改动文件）现在就读：合回去以后分支和目录会被删掉；共用目录的用这个对话记下的改动
  const [commits, changed] = wt
    ? await Promise.all([
        branchCommits(wt.path, tk.baseRef).catch(() => []),
        gitNumstat(wt.path, tk.baseRef, placedFiles(tk)).catch(() => null),
      ])
    : [[], Object.fromEntries(tk.changes.map((c) => [c.path, `+${c.add} -${c.del}`]))]
  const request = tk.messages.find((m) => m.role === 'user' && !m.step && !m.panel)?.text ?? ''
  tk.handoff = {
    text: handoffText(handoff, {
      title: tk.title,
      request,
      note,
      tests,
      branch: wt?.branch ?? '',
      base: wt?.baseBranch ?? '',
      commits,
      changed: changed ?? {},
      triage: triageText(triage),
      override: bypass ? overrideText(bypass) : '',
      shared: !wt,
    }),
    files: handoff.files ?? '',
    at,
  }
  // 改了什么才编译什么：只改 Lua、配置、表格、资源、文档时合回后不申请 UE 编译（Lua 用 luac -p 查语法就够）
  const files = [...new Set([...Object.keys(changed ?? {}), ...tk.changes.map((c) => c.path)])]
  const noBuild = build ? await buildSkip(sc, tk, files) : ''
  if (noBuild) build = false
  tk.wrapRequest = { state: 'requested', at, note, tests, ...(build && { build }), info: '' }
  // 简版报告：不用用户确认，在子对话里记一行能展开回看（再次收尾时换成最新的）
  if (tk.bug?.kind === 'fix') {
    const brief = (bugOf(tk).fixBrief = fixBriefOf(handoff, note, tests, files, at))
    tk.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: fixBriefMd(brief),
      tools: [],
      panel: 'note',
      at,
    })
  }
  // 校验都过了才记放行；这次没绕过门禁就清掉旧的，留着的只能是当前这次收尾的放行
  tk.reviewOverride = bypass
  markChildWrapUp(tk, 'waiting', wt ? '已请父对话收尾，等父对话合并' : '已请父对话验收，等父对话收下')
  tk.updatedAt = at
  if (entry) entry.rev++
  await sc.store.update(tk.id, tk)
  // 共用目录：交了就不再改，声明了没碰的让出来；改过的留到父对话验收（completeChild 释放）
  if (!wt) shrinkClaims(sc.claims, tk)
  // 这次请求本身就是一次状态上报：一轮结束时不再报一遍「待收尾」
  sc.reportedState.set(childId, sc.reportKey(tk, 'wrapup'))
  const child = { id: tk.id, title: tk.title, state: 'wrapup' as const }
  // 用户报的 Bug（ADR 0046）：Bug 记录的草稿跟着收尾请求交给父对话
  const record = bugRecordDraft(tk)
  const delivered = await wakeTask(
    sc,
    parentId,
    tk,
    `【收尾请求】子对话「${tk.title}」（id ${tk.id}）只剩${wt ? '合回' : '验收'}了：计划其余步骤都做完、后台命令都结束、没有待回答的提问。
${wt ? `它在独立分支 ${wt.branch} 里的验证` : '它和你共用目录（改动已经在你的目录里，没有分支要合），它的验证'}：${clipWithFile(parentId, `「${tk.title}」的验证`, tests, 600)}${noBuild ? `\n合回后不用编译：${noBuild}` : ''}${note ? `\n它的说明：${clipWithFile(parentId, `「${tk.title}」的说明`, note, 300)}` : ''}${triage.length ? `\n它对评审意见的处置（评审只出意见，采不采纳是它核实后定的；驳回或留作已知问题的理由站不住时打回给它）：\n${clipWithFile(parentId, `「${tk.title}」的评审处置`, triageText(triage), 1500)}` : ''}${tk.bug?.fixBrief ? `\n${clipWithFile(parentId, `「${tk.title}」的修复简报`, fixBriefPrompt(tk.bug?.fixBrief), 1500)}` : ''}${record ? `\n这是用户报的 Bug。收下它（finish_child）之后：${BUG_RECORD_ASK}下面是 Bug 记录的草稿（用户同意写时派「文档」原样附上，不用它再从对话里摘）：\n${clipWithFile(parentId, `「${tk.title}」的 Bug 记录草稿`, record, 1500)}` : ''}${bypass ? `\n⚠️ 它这次的收尾用了**显式放行**：评审门禁被绕过，记录如下（谁、什么时候、为什么、原本拦住什么）——用户要求带着这个问题先合并，你如果觉得理由站不住，打回给它或者直接问用户：\n${overrideText(bypass)}` : ''}
${
  wt
    ? `请你收尾：调用 finish_child（id ${tk.id}），面板把它的分支合回「${wt.baseBranch || '你所在的分支'}」、把它计划里的收尾步骤标完成、结束它并删除独立分支和分支。`
    : `请你验收：核对它的验证和改动，没问题就调用 finish_child（id ${tk.id}），面板把它计划里的收尾步骤标完成、结束它。`
}验证不够、你看出问题时不要收，用 send_to_conversation 把要补的交回给它。`,
    {
      panel: 'wrapup',
      child,
      peer: await sc.peerOf(tk, 'child', 'wrapup', note || (wt ? '只剩合回，请收尾' : '只剩验收，请收尾')),
    },
  )
  // 没能马上交给父对话（退回了收件箱）：父对话空着就没人开新的一轮，过一会儿按「有子对话在等收尾」推它一次
  if (!delivered) setTimeout(() => void recheckWrapUp(sc, parentId), ctx.wrapRecheckMs).unref?.()
  return {
    ok: true,
    info: wt
      ? `已请父对话收尾：它会把你的分支合回原分支、标完成并删除独立分支，结果推回给你。${noBuild ? `合回后不申请编译：${noBuild}` : ''}现在结束这一轮，不要再改文件（这次提交之后再改的不在这次合并里）；父对话退回要你补的，按它说的做完再调用 submit_merge。`
      : '已请父对话验收：它核对后标完成，结果推回给你。现在结束这一轮，不要再改文件；父对话退回要你补的，按它说的做完再调用 submit_merge。',
  }
}
