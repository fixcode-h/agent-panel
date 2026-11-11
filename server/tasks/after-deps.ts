/**
 * 子对话之间的先后依赖（create_conversation 的 after，判定在 shared/child-after.ts）：
 * 前置子对话合回（childMerged）或一轮结束上报（reportChild）时扫一遍父对话名下在等的子对话，
 * 前置都合回了就启动它（这时父对话的分支已经带着合回的提交，独立分支从这里开）；前置失败、没了就不启动、告诉父对话一次
 */
import { randomUUID } from 'node:crypto'
import { withProjectParams } from '../../shared/builtin/core.ts'
import { afterDecision, waitingAfter } from '../../shared/child-after.ts'
import { t } from '../../shared/i18n.ts'
import type { Task } from '../../shared/schema.ts'
import { taskDeleted } from '../../shared/task.ts'
import { log } from '../log.ts'
import type { TasksScope } from './scope.ts'

export function createAfterDeps(sc: TasksScope) {
  /** 已经告诉过父对话的「前置等不到了」：子对话 id + 前置 id + 前置状态，同一件事只说一次 */
  const told = new Set<string>()
  /** 正在启动的：两次扫描撞在一起时不启动两遍 */
  const starting = new Set<string>()

  /** 把等待中的子对话改成开始：清掉等待，按原来的派单（可带父对话补充的一段）启动 */
  async function launch(kid: Task, extra?: { text: string; parent: Task }) {
    if (starting.has(kid.id) || sc.live.has(kid.id)) return { ok: false, info: `子对话「${kid.title}」已经在启动了` }
    starting.add(kid.id)
    try {
      // 列表里的记录（childrenOf）只留了部分消息，写回去会把对话截掉：从盘上取完整的
      const k = await sc.store.get(kid.id)
      if (!k || !waitingAfter(k)) return { ok: false, info: `子对话「${kid.title}」已经不在等前置了` }
      const project = await sc.deps.projects.get(k.projectId)
      if (!project) return { ok: false, info: '找不到子对话所在的项目' }
      const agents = withProjectParams(await sc.deps.agents.list(), project)
      const first = k.messages.find((m) => m.role === 'user')?.text ?? ''
      k.waitAfter = undefined
      k.stopReason = undefined
      k.status = 'running'
      if (extra)
        k.messages.push({
          id: randomUUID(),
          role: 'user',
          agentId: '',
          step: '',
          text: extra.text,
          tools: [],
          peer: await sc.peerOf(extra.parent, 'parent', 'task', extra.text),
          at: new Date().toISOString(),
        })
      k.updatedAt = new Date().toISOString()
      await sc.store.update(k.id, k)
      log.info('task', '前置子对话已合回，启动排在后面的子对话', { task: k.id })
      void sc.startChild(k, extra ? `${first}\n\n父对话补充：${extra.text}` : first, agents)
      return { ok: true, info: `子对话「${k.title}」开始执行了，完成后会回报到这里` }
    } finally {
      starting.delete(kid.id)
    }
  }

  /** 扫一遍父对话名下在等前置的子对话：能开始的启动，等不到的告诉父对话 */
  async function releaseAfter(parentId: string) {
    if (sc.shuttingDown) return
    const kids = (await sc.store.childrenOf(parentId)).map((k) => sc.live.get(k.id)?.task ?? k)
    for (const k of kids) {
      if (!waitingAfter(k) || taskDeleted(k) || k.archived || sc.live.has(k.id)) continue
      const d = afterDecision(k.waitAfter!, (id) => kids.find((x) => x.id === id))
      if (d.start) {
        await launch(k).catch((e) => {
          log.error('task', '启动排在后面的子对话失败', { task: k.id, error: (e as Error).message })
          sc.alertOn(parentId, 'panel', t('启动排在后面的子对话时出错'), 'error')(e)
        })
        continue
      }
      const fresh = d.bad.filter((b) => !told.has(`${k.id}\n${b.id}\n${b.why}`))
      if (!fresh.length) continue
      fresh.forEach((b) => told.add(`${k.id}\n${b.id}\n${b.why}`))
      await sc.noteParent(
        parentId,
        k,
        `【前置没合回】子对话「${k.title}」（id ${k.id}）排在 ${fresh.map((b) => `「${b.title}」（id ${b.id}）`).join('、')} 之后，` +
          `${fresh.map((b) => `「${b.title}」${b.why}`).join('；')}，所以它还没启动。` +
          `前置修好合回后它会自动开始；要它现在就开始，用 send_to_conversation 交给它（写清前置没做完、它该怎么办）；确实不做了就在计划里把那一步标跳过。`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      )
    }
  }

  /** 父对话给还在等前置的子对话交消息：当作「现在就开始」，原派单加上这段补充一起交给它 */
  async function startAfterNow(parent: Task, k: Task, text: string) {
    const r = await launch(k, { text, parent })
    if (!r.ok) return r
    return { ok: true, info: `${r.info}（它原本排在别的子对话之后，你交了消息，就不再等它们了）` }
  }

  return { releaseAfter, startAfterNow }
}
