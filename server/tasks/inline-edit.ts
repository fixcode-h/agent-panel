import { coreDefinition } from '../../shared/builtin/core.ts'
import { doneEvidence } from '../../shared/done-evidence.ts'
import {
  inlineEditBlocker,
  inlineEditGate,
  inlineEditOverrun,
  inlineEditOverrunText,
} from '../../shared/inline-edit.ts'
import { panelToolName } from '../../shared/panel-tools.ts'
import type { Task } from '../../shared/schema.ts'
import { mustIds, verdictOf } from '../../shared/submitted.ts'
import { currentTestSteps, stepApplies } from '../../shared/test-steps.ts'
import { placedFiles } from '../attachments.ts'
import { normClaimPath, overlaps } from '../claims.ts'
import { gitChanges, gitHead, gitNumstat } from '../exec/git.ts'
import type { TasksScope } from './scope.ts'
import { freshTask } from './read.ts'

/**
 * 父对话的就地微改动（shared/inline-edit.ts）：开始时的护栏、结束时的快速检查和轻评审门禁、越界核对。
 * 从 server/tasks/merge/ 挪出来（那个函数到了长度上限），收尾门禁是摸底报告第 6 条加的
 */
export function createInlineEdit(sc: TasksScope) {
  /**
   * 父对话开始就地微改动（shared/inline-edit.ts）：子对话正在合回、要改的文件有子对话在用（共用目录的认领、
   * 独立分支划的范围或已经改了的文件）时拒绝；能开始就记下声明的范围和工作区基线，结束时按它核对真实改动
   */
  async function beginInlineEdit(parent: Task, dir: string, files: string[], reason: string) {
    const kids = (await sc.store.childrenOf(parent.id)).map((k) => freshTask(sc, k))
    const merging = kids
      .filter(
        (k) =>
          k.child?.wrapRequest &&
          (k.child?.wrapRequest.state === 'merging' || k.child?.wrapRequest.state === 'testing'),
      )
      .map((k) => k.title)
    const want = files.map(normClaimPath).filter(Boolean)
    const held: { path: string; by: string }[] = []
    for (const c of sc.claims.list(parent.id))
      if (c.taskId !== parent.id && want.some((w) => overlaps(c.path, w))) held.push({ path: c.path, by: c.title })
    const declared = sc.scopes.get(parent.id)
    for (const k of kids) {
      if (k.resolved) continue
      const busy = [...(declared?.get(k.id)?.files ?? []), ...k.changes.map((c) => c.path)]
      for (const p of want) if (busy.some((b) => overlaps(b, p))) held.push({ path: p, by: k.title })
    }
    const why = inlineEditBlocker({ files, reason, merging, held, active: !!parent.inlineEdit })
    if (why) return { ok: false, info: why }
    const head = await gitHead(dir)
    const baseline = await gitNumstat(dir, head, placedFiles(parent))
    if (!baseline) return { ok: false, info: '这个目录不是 git 仓库，没法核对就地改动：交给子对话做' }
    parent.inlineEdit = { files, reason, startedAt: new Date().toISOString(), head, baseline }
    return {
      ok: true,
      info: `可以改了：${files.join('、')}。改完跑项目测试步骤里标「快速」的检查，按版本控制的规则本地提交（只提交这几个文件），派一次轻评审（spawn_agents 的 agent 写「评审」，只看这次改动），评审通过再调用 end_inline_edit。改动期间不能收尾子对话、不能派子对话。`,
    }
  }

  /**
   * 这次就地改动开始之后跑通过的测试步骤：开始那次 begin_inline_edit 之后的命令（工具调用的退出码）
   * 加上后台命令记下的测试结果（按真实起止时间记的，不靠 Agent 自报）
   */
  function passedSince(parent: Task, steps: { name: string; command: string }[], startedAt: string) {
    const msgs = parent.messages
    let from = 0
    msgs.forEach((m, i) => {
      if (m.tools?.some((x) => panelToolName(x.name ?? '') === 'begin_inline_edit')) from = i
    })
    const ran = doneEvidence(msgs.slice(from), steps)
      .commands.filter((c) => c.step && !c.failed && (c.exitCode === undefined || c.exitCode === 0))
      .map((c) => c.step!)
    const bg = (parent.testRuns ?? []).filter((r) => r.ok && r.at >= startedAt).map((r) => r.stepName)
    return [...new Set([...ran, ...bg])]
  }

  /** 收尾门禁要的材料：项目里标「快速」的步骤（改动对得上的）、跑通过的、开始之后派的评审 */
  async function gateOf(parent: Task, st: NonNullable<Task['inlineEdit']>, files: string[]) {
    const project = parent.projectId ? await sc.deps.projects.get(parent.projectId).catch(() => null) : null
    const quick = currentTestSteps(parent.testSteps, project).filter(
      (s) => s.enabled && s.quick && !s.merge && !!s.command.trim() && stepApplies(s, files),
    )
    const reviewerName = coreDefinition('reviewer').agent.name
    const known = await sc.deps.agents.list().catch(() => [])
    const isReviewer = (id: string) =>
      known.some((a) => a.id === id && (a.origin === 'builtin:reviewer' || a.name === reviewerName))
    const reviews = parent.steps
      .filter((s) => s.slot === 'sub' && !!s.agentId && isReviewer(s.agentId) && s.startedAt >= st.startedAt)
      .map((s) => ({ title: s.title, status: s.status, verdict: verdictOf(s) || undefined, must: mustIds(s).length }))
    return inlineEditGate({ head: st.head, quick, passed: passedSince(parent, quick, st.startedAt), reviews })
  }

  /**
   * 结束就地微改动：先过收尾门禁（快速检查通过、轻评审通过，第 6 条），没过就拒绝、改动保持进行中；
   * 过了再按真实改动核对文件数、行数和没声明的文件，越界写一条醒目警告；没提交的改动列出来。
   * force：这一轮结束时面板自动收（不能让下一轮一直拦着收尾子对话），门禁没过就告诉用户这次改动没走完检查
   */
  async function endInlineEdit(parent: Task, dir: string, force = false) {
    const st = parent.inlineEdit
    if (!st) return { ok: true, info: '没有进行中的就地改动' }
    const changes = (await gitChanges(dir, st.baseline, st.head, placedFiles(parent))) ?? []
    const gate = changes.length
      ? await gateOf(
          parent,
          st,
          changes.map((c) => c.path),
        )
      : ''
    if (gate && !force) return { ok: false, info: gate }
    if (gate)
      await sc.panelAlert(
        parent.id,
        'panel',
        `就地改动在这一轮结束时自动收了，但没走完快速检查和评审：${gate}`,
        changes.map((c) => c.path).join('、'),
      )
    // 清字段写 undefined（见 docs/lessons/data.md）
    parent.inlineEdit = undefined
    const r = inlineEditOverrun(st.files, changes)
    const now = (await gitNumstat(dir, '', placedFiles(parent))) ?? {}
    const uncommitted = changes.map((c) => c.path).filter((p) => p in now && st.baseline[p] !== now[p])
    if (r.over) await sc.panelAlert(parent.id, 'panel', inlineEditOverrunText(r), r.undeclared.join('、') || '')
    return {
      ok: true,
      info: [
        `就地改动结束：改了 ${r.files} 个文件、${r.lines} 行。`,
        uncommitted.length ? `还没提交：${uncommitted.join('、')}——按版本控制的规则提交，或者说明为什么不提交。` : '',
        r.over ? inlineEditOverrunText(r) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  return { beginInlineEdit, endInlineEdit }
}
