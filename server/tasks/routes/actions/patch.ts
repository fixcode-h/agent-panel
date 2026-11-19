import { Hono } from 'hono'
import { z } from 'zod'
import { TaskPatch, Task, defaultAgent } from '../../../../shared/schema.ts'
import { childHoldText } from '../../../../shared/task.ts'
import { helpersWorking } from '../../../../shared/tasks/helpers.ts'
import { withTaskModel } from '../../../../shared/tasks/run.ts'
import { agentRun } from '../../../../shared/settings.ts'
import { childAskEffect } from '../../../../shared/children/ask.ts'
import { getSettings } from '../../../settings.ts'
import { cancelWait } from '../../../exec/steering.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'
import { forgetClaims } from '../../../claims.ts'
import { scopeError } from '../../../../shared/conv-mode.ts'
import { readTask } from '../../read.ts'

/** 导入的任务上也能改的字段：只是标记，不碰执行 */
// 模块状态：常量，导入的任务上也能改的字段
const MARK_KEYS = new Set(['title', 'archived', 'pinned'])

/** PATCH /tasks/:id：改对话设置（标题、归档、置顶、完成、角色、CLI / 模型 / 强度、提问开关……） */
export function patchRoute(s: TasksScope): Hono {
  const app = new Hono()
  app.patch('/:id', async (c) => {
    const id = c.req.param('id')
    const p = TaskPatch.safeParse(await c.req.json())
    if (!p.success) return s.bad(c, z.prettifyError(p.error))
    const e = s.live.get(id)
    const cur = e?.task ?? (await s.store.get(id))
    if (!cur) return s.bad(c, t('任务不存在'), 404)
    // 导入的任务只能看：标题、归档、置顶这类只是标记，照样能改
    if (cur.imported && Object.keys(p.data).some((k) => !MARK_KEYS.has(k))) return s.bad(c, s.READONLY, 409)
    // 子对话标记完成：它的独立分支跟着删掉。改动还没合回原分支时不标，免得把没合的改动一起删了
    if (p.data.resolved === true && cur.parentTaskId) {
      // 用户点「解决」只是发起这一趟流转：判定和置完成在子对话那一侧，还有没收口的东西就拒绝并说清卡在哪一项，
      // 不在这里直接写子对话的最终状态。fromUser 表示这一趟是用户手动点解决的：计划里没做完的步骤一并收口，
      // 不再因为「计划没做完」返回 409（父对话收尾、一轮结束收口仍按原样拦，见 advanceChildTo）
      const { holds, info } = await s.advanceChildTo(id, { fromUser: true })
      if (holds.length) return s.bad(c, info || childHoldText(holds), 409)
      Object.assign(cur, {
        resolved: true,
        worktree: ((await readTask(s, id)) ?? cur).worktree,
      })
    }
    // 取消完成：再完成一次时该重新上报父对话
    if (p.data.resolved === false && cur.parentTaskId) {
      s.reportedDone.delete(id)
      s.mergeNudged.delete(id)
    }
    // 归档：只拦正在执行这一轮的；CLI 只是活着（等下一句、预热）时照样归档，顺手结束这个进程和它名下的子对话
    if (p.data.archived === true && e) {
      if (e.task.working) return s.bad(c, t('对话正在执行，等这一轮结束或停止后再归档'), 409)
      if (!cancelWait(id)) s.stopTask(id, 'archive')
      else void s.closeChildren(id)
    }
    // 归档的对话不再接收结果：后台命令（连同名下子对话的）一起停掉
    if (p.data.archived === true) {
      await s.endBackground(id)
      // 归档了就不会再交改动：它名下的认领（它是父对话时整组）放掉
      forgetClaims(s.claims, cur)
    }
    const beforeAgentId = cur.agentId
    const agentChanged = p.data.agentId !== undefined && p.data.agentId !== beforeAgentId
    const touchesRun =
      p.data.cli !== undefined ||
      p.data.model !== undefined ||
      p.data.effort !== undefined ||
      p.data.modelOverride !== undefined ||
      agentChanged
    if (touchesRun && cur.mode === 'workflow') return s.bad(c, t('只有对话任务可以这样做'))
    const settings = touchesRun ? await getSettings() : undefined
    const agents = touchesRun ? await s.deps.agents.list() : undefined
    if (agentChanged && p.data.agentId && !agents?.some((a) => a.id === p.data.agentId))
      return s.bad(c, t('找不到这个角色'))
    // 换角色也要同一类（ADR 0038）：Chat 页的对话换不成 Agent 角色，项目里的换不成 Chat 角色。
    // 只在角色真的变了时校验：旧数据里 Chat 页用着 Agent 角色的对话，带上原来的 agentId 改别的字段不能被拒
    const wrongScope =
      agentChanged && p.data.agentId
        ? scopeError(
            cur,
            agents?.find((a) => a.id === p.data.agentId),
          )
        : ''
    if (wrongScope) return s.bad(c, wrongScope)
    const runOf = (t: Task) => {
      const agent = t.agentId ? agents?.find((a) => a.id === t.agentId) : { ...defaultAgent(), id: '' }
      return agent && settings ? agentRun(withTaskModel(agent, t), settings) : undefined
    }
    const beforeRun = runOf(cur)
    // 换 CLI 前记下会话是哪个 CLI 的（以前的任务没记），下一轮才知道要开新会话
    if (p.data.cli !== undefined && !cur.sessionCli && cur.sessions[cur.agentId]) {
      const agent = cur.agentId ? agents?.find((a) => a.id === cur.agentId) : { ...defaultAgent(), id: '' }
      if (agent && settings) cur.sessionCli = agentRun(withTaskModel(agent, cur), settings).cli
    }
    const task = cur
    const { childRun, applyChildAsk, ...rest } = p.data
    // 「提问」联动（见 shared/children/ask.ts）：按钮关父对话时已有子对话一起关，右键菜单改的是「之后新建」的默认值，
    // 勾上时再按用户选的「应用到已创建」决定已有的要不要一起开。先算出结论，下面一起应用
    const askEffect = childAskEffect({
      askUser: p.data.askUser,
      childAskUser: p.data.childAskUser,
      applyExisting: applyChildAsk,
    })
    Object.assign(task, rest)
    if (askEffect.askUser !== undefined) task.askUser = askEffect.askUser
    if (askEffect.childAskUser !== undefined) task.childAskUser = askEffect.childAskUser
    // null 表示改回按执行角色自己的配置
    if (childRun !== undefined) task.childRun = childRun ?? undefined
    // 用户自己起了名：之后不再自动换标题
    if (p.data.title !== undefined) task.autoTitle = false
    if (agentChanged) {
      // 换了角色后旧会话里是另一个 Agent 的设定：清掉会话，下一轮新开会话并带上之前的对话摘要
      delete task.sessions[task.agentId]
      delete task.sessions[beforeAgentId]
      delete task.sessionDirs[task.agentId]
      delete task.sessionDirs[beforeAgentId]
      task.sessionCli = undefined
      const history = task.messages
        .filter((m) => !m.transient && m.text.trim())
        .slice(-20)
        .map((m) => `${m.role === 'user' ? '用户' : 'Agent'}：${m.text.trim().slice(0, 300)}`)
        .join('\n')
      task.rewind = history
        ? { session: '', through: null, latest: false, summary: history }
        : { session: '', through: null, latest: false }
    }
    if (askEffect.askUser !== undefined) await s.applyAskUser(task, askEffect.askUser, !!e?.task.working)
    // 右键菜单选了「应用到已创建的子对话」才改已有的（引擎按各自的 askUser 判断，界面靠推送和定时刷新跟着变）
    if (askEffect.existingChildren !== undefined) await s.applyChildAskUser(task, askEffect.existingChildren)
    // 执行中的任务平时按节点落盘，改名这类操作要马上写下去，否则重启后会丢。
    // 只改置顶时不动列表时间：置顶只是标记，不该让这条聊天在别处（最近活动、未读）显得「刚更新过」
    const onlyPin = Object.keys(p.data).every((k) => k === 'pinned')
    const afterRun = touchesRun ? runOf(task) : undefined
    // 换了 CLI：旧 CLI 列的待办不会再有人更新，清掉，不然一直显示上一个 CLI 的进度
    if (beforeRun && afterRun && beforeRun.cli !== afterRun.cli) task.todos = []
    await s.store.update(id, task, onlyPin ? { keepUpdatedAt: true } : undefined)
    if (!touchesRun) return c.json(task)
    const runChanged =
      agentChanged ||
      (!!beforeRun &&
        !!afterRun &&
        (beforeRun.cli !== afterRun.cli || beforeRun.model !== afterRun.model || beforeRun.effort !== afterRun.effort))
    if (!runChanged) return c.json(task)
    // 正在回复这一轮、或者在等派出的子任务（它们跑在这个进程的这一轮里）：不能现在换进程；
    // 这一轮结束时 start 的收尾、下一条消息交付时都会按新的选择重开
    if (e?.task.working || (e && helpersWorking(e.task))) return c.json(task)
    // 空闲的常驻 CLI：让它结束，按新的选择重新预热，命令和上下文不再显示旧 CLI
    if (e) {
      e.restart = true
      const canceled = cancelWait(id)
      if (!canceled) s.stopTask(id, 'switch')
      if (!e.done) return c.json(task)
      await e.done
      // 子对话不跟着重启：它们有自己的 CLI 和模型，还在跑的被杀就是误杀
      // 这一轮结束后要处理的消息由收尾的 followUp 用新的选择接着跑，不要在这里和它抢执行位
      if (s.live.has(id)) return c.json(s.live.get(id)!.task)
      if (!canceled) task.status = 'done'
    }
    task.command = []
    delete task.usage.agents[task.agentId]
    task.working = false
    task.awaitingUser = false
    task.prewarming = false
    await s.store.update(id, task)
    return c.json(await s.prewarmChat(task, true))
  })
  return app
}
