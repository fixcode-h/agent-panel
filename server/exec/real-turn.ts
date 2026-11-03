/** 真实执行一轮：调度交给执行引擎（shared/engine.ts），调用 Agent 时经 runner 启动对应 CLI。从 runner.ts 拆出 */
import { HANDOFF_DIR } from '../store.ts'
import { docRootOf, lookupModuleDocs } from '../module-map.ts'
import { type EngineHost, runEngineTurn } from '../../shared/engine.ts'
import type { RealContext } from './real-context.ts'
import { activePlan, inputUnhandled, planNotice } from '../../shared/plan.ts'
import { askPushRequest, dropOwnRequests, panelRequest } from './panel-requests.ts'
import { clip } from '../../shared/text.ts'

import { detectVcs } from '../projects-analyze.ts'
import { gatedRunAgent } from './runner.ts'
import { listIntegrations } from '../integrations.ts'
import { log } from '../log.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { placedFiles } from '../attachments.ts'
import { projectDocRoot } from '../doc-root.ts'
import { projectFormat } from '../file-format.ts'
import { gitHasRemote, reviewDiff } from './git.ts'
import { saveHandoffFile } from './handoff-file.ts'
import { searchExcludeOf } from '../../shared/search-exclude.ts'
import { steers, waitChat } from './steering.ts'
import { t } from '../../shared/i18n.ts'
import { taskChanges } from '../own-changes.ts'
import { yieldApiSlot } from './api-gate.ts'

/**
 * 这次执行里能用的授权：项目设置的推送策略、这个对话里用户已经做过的选择、
 * 本机已经装好并登录的外部工具（gh、cloudflared 等）。列进提示词，模型不用重新探测
 */
async function taskPolicy(ctx: RealContext): Promise<EngineHost['policy']> {
  const views = await listIntegrations().catch(() => [])
  // cherry-pick 目标只对 Git / P4 项目有意义：按项目目录现在的版本管理说清怎么搬（目录换了类型就不提）
  const target = ctx.project.cherryPick?.trim()
  const vcs = ctx.project.path ? (await detectVcs(ctx.project.path).catch(() => null))?.vcs : undefined
  // Git 仓库没配远端：没有地方可推。不探的话「问一次」的项目会在每次合回后弹推送授权卡（2026-11-03 真实 API 实测）
  const noRemote = vcs === 'git' && !(await gitHasRemote(ctx.project.path).catch(() => true))
  return {
    push: ctx.project.gitPolicy ?? 'ask',
    ...(noRemote && { noRemote: true }),
    // 用户对推送的回答（task.remotePush）不在这一刻定死：getter 现取，回答记上之后保活的下一条消息（nextPrompt 重拼）才看得到
    get answered() {
      return ctx.task.remotePush
    },
    tools: views.filter((v) => v.installed && v.authed).map((v) => v.name),
    ...(target && (vcs === 'git' || vcs === 'p4') ? { cherryPick: { vcs, target } } : {}),
    docs: await projectDocRoot(ctx.project.path, ctx.agents, vcs ?? 'none'),
    // P4 / SVN 以外的项目文档根也由面板给，和查模块文档同一个算法（不然「文档」会按 P4 用的参数写到项目外）
    ...(vcs !== 'p4' &&
      vcs !== 'svn' &&
      ctx.project.path && { docRoot: await docRootOf(ctx.project.path, ctx.agents) }),
  }
}

/** 真实执行一轮：调度交给执行引擎，调用 Agent 时启动对应 CLI */
export async function runRealTurn(ctx: RealContext) {
  ctx.task.simulated = false
  // ADR 0020：这一轮的计划提醒（滞后 / 新输入没跟着改）由 engine 的 planPart 写进提示词；
  // 服务端在这里留一条日志，方便事后确认「到底提醒过没有」。新输入的提醒只算一次：
  // 这一轮结束后记下「提醒过这次输入」，同一个要求不会每轮重复追问（对话选择「不改计划、说明一句」时尤其需要）
  const plan = activePlan(ctx.task)
  const unhandled = plan ? inputUnhandled(plan) : undefined
  // 本轮提醒的是「这一次输入」：轮中随时可能又来新消息（deliver 会更新 lastInputAt），
  // 轮末不能再读 lastInputAt，否则会把没提醒过的那次也标成已提醒（评审 R2）
  const noticedInput = unhandled !== undefined ? plan?.lastInputAt : undefined
  const notice = planNotice(ctx.task)
  if (notice) log.warn('plan', '计划需要对话收口，已写进这一轮的提示词', { task: ctx.task.id, notice })
  // 这一轮弹出的推送授权卡：这一轮结束时还没回答就作废（等着它的 CLI 已经不在了）
  const ownAsks = new Set<string>()
  await runEngineTurn({
    task: ctx.task,
    agents: ctx.agents,
    workflows: ctx.workflows,
    workflow: ctx.workflow,
    prompt: ctx.prompt,
    policy: await taskPolicy(ctx),
    resume: ctx.resume,
    prewarm: ctx.prewarm,
    prewarmFrom: ctx.prewarmFrom,
    prewarmTurnDoneAt: ctx.prewarmTurnDoneAt,
    changed: ctx.changed,
    newId: ctx.newId,
    // 项目设置优先、没设时跟随全局：默认 UTF-8 无 BOM + LF
    fileFormat: projectFormat(ctx.project, ctx.settings),
    // 项目设置里的搜索排除清单（项目填的 + 内置默认），写进提示词的搜索段
    searchExclude: searchExcludeOf(ctx.project),
    searchInGit: ctx.isGit,
    workflowCatalog: ctx.workflowCatalog,
    resolveWorkflow: ctx.resolveWorkflow,
    listConversations: ctx.listConversations,
    createConversation: ctx.createConversation,
    sendToConversation: ctx.sendToConversation,
    // 全局规则、目标在 run.ts 里是 getter（现取父对话的）：这里也转成 getter，别在建 host 时求值成快照
    get rules() {
      return ctx.rules
    },
    get goal() {
      return ctx.goal
    },
    takeInbox: ctx.takeInbox,
    messageParent: ctx.messageParent,
    claimFiles: ctx.claimFiles,
    releaseFiles: ctx.releaseFiles,
    childIsolation: ctx.childIsolation,
    worktreeHome: ctx.worktreeHome,
    branch: ctx.branch,
    // 收尾种类在 run.ts 里是 getter（按现在的推送授权算）：保活中用户点了「允许」，下一条消息就带上推送收尾
    get wrapUp() {
      return ctx.wrapUp
    },
    p4Split: ctx.p4Split,
    cherryPick: ctx.cherryPick,
    submitMerge: ctx.submitMerge,
    isolated: ctx.isolated,
    finishChild: ctx.finishChild,
    ueBuild: ctx.ueBuild,
    peers: ctx.peers,
    messagePeer: ctx.messagePeer,
    verify: ctx.verify,
    beginEdit: ctx.beginEdit,
    inlineEdit: ctx.inlineEdit,
    runBackground: ctx.runBackground,
    cliTodos: ctx.cliTodos,
    checkBackground: ctx.checkBackground,
    stopBackground: ctx.stopBackground,
    forwardSpawn: ctx.forwardSpawn,
    onOrchestra: ctx.onOrchestra,
    lessons: ctx.lessons,
    runAgent: (call) => gatedRunAgent(ctx, ctx.op && !call.step ? { ...call, op: ctx.op } : call),
    yieldSlot: (stepId, wait) => yieldApiSlot(ctx, stepId, wait),
    signal: ctx.signal,
    stopReason: ctx.stopReason,
    // 对话等子任务时用户发来的消息：马上开一轮回复
    waitChat: ctx.task.mode === 'chat' ? (signal) => waitChat(ctx.task, signal, ctx.changed) : undefined,
    // 编排工具的传话：交给正在跑的那个节点（CLI 支持执行中补充时），交不了由引擎放进它的收件箱
    steer: async (stepId, text) => {
      for (const s of steers.get(ctx.task.id) ?? [])
        if (s.step === stepId && (await s.steer(text))) {
          s.accepted()
          return true
        }
      return false
    },
    // 停止任务时不再等，节点停在这里，继续执行时重新确认
    confirm: (step, text) =>
      panelRequest(ctx, {
        step: step.id,
        agentId: step.agentId,
        kind: 'confirm',
        title: t('「{title}」完成了，看一下结果再继续', { title: step.title }),
        // 审阅弹窗按文档渲染整段结果、还要在上面标注，截得太短看不全
        detail: clip(text, 40000),
      }),
    askPush: (info) => askPushRequest(ctx, info, ownAsks),
    // 先建模块文档再开子对话（ADR 0048）：只有项目顶层对话建子对话，文档根按项目设置算
    moduleDocs: ctx.task.parentTaskId
      ? undefined
      : (modules) => lookupModuleDocs(ctx.project.path, ctx.agents, modules),
    reviewDiff: ctx.isGit
      ? async (since, files) => {
          // 没点名文件时只取这个对话改过的（和「更改」面板一致）：对话开始前就没提交的改动不算它的，不交给评审
          const own =
            files ??
            (since ? undefined : (await taskChanges(ctx.project.path, ctx.task).catch(() => null))?.map((c) => c.path))
          const d = await reviewDiff(ctx.project.path, ctx.task.baseRef, since, own, placedFiles(ctx.task))
          if (!d) return null
          if (d.diff || !d.full) return { snapshot: d.snapshot, stat: d.stat, diff: d.diff }
          // 太长：完整差异存进交接目录，提示词里只给文件列表和路径
          const dir = path.join(HANDOFF_DIR, ctx.task.id)
          await mkdir(dir, { recursive: true })
          const file = path.join(dir, `review-${d.snapshot.slice(0, 12)}.diff`)
          await writeFile(file, d.full)
          return { snapshot: d.snapshot, stat: d.stat, diff: '', file }
        }
      : undefined,
    saveHandoff: (step, text) => saveHandoffFile(ctx.task.id, step, text),
  }).finally(() => dropOwnRequests(ctx.task, ownAsks))
  if (noticedInput && plan) {
    plan.inputNotedAt = noticedInput
    ctx.changed()
  }
}
