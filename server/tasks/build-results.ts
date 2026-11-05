import { randomUUID } from 'node:crypto'
import type { Task, TaskMessage } from '../../shared/schema.ts'
import { settleBuildJob } from '../../shared/build-ask.ts'
import { t } from '../../shared/i18n.ts'
import { log } from '../log.ts'
import type { TasksScope } from './scope.ts'

/**
 * 父对话替子对话起的 UE 编译跑完了（一条后台命令）：按子对话任务上的记录（buildAsk，会落盘）把结果推回去。
 * 以前按内存里的对应表推，父对话漏写 children、面板重启都会丢，子对话收不到结果（用户 2026-11-04 报）。
 *
 * 编译通过、子对话已经请了收尾（待收尾）时不叫醒它：叫醒会开新的一轮，run.ts 会把它的收尾请求作废，
 * 它还得再 submit_merge 一次，常常就停在那里。这时只在它的对话里记一行结果，改为在父对话收到的结果里点名
 * 「它在等你收尾，调用 finish_child」——父对话这一侧才是该动的一方。失败照旧叫醒子对话去修。
 *
 * 返回要接在父对话这条结果后面的话（没有就是空串）
 */
export async function forwardBuildResult(
  sc: TasksScope,
  job: { id: string; state: string; taskId: string },
  result: string,
): Promise<string> {
  const kids = (await sc.store.list())
    .filter((k) => k.buildAsk?.state === 'building' && k.buildAsk.jobs.includes(job.id))
    .map((k) => sc.live.get(k.id)?.task ?? k)
  const tail: string[] = []
  for (const kid of kids) {
    const ok = job.state === 'done'
    const r = settleBuildJob(kid.buildAsk!, job.id, ok, result.split('\n')[0].slice(0, 300), new Date().toISOString())
    kid.buildAsk = r.ask
    const entry = sc.live.get(kid.id)
    if (entry) entry.rev++
    await sc.store.update(kid.id, kid)
    // 一次编译分好几条命令时，全部跑完（或有一条失败）才算出结果
    if (!r.result) continue
    if (r.result === 'passed' && kid.wrapRequest?.state === 'requested') {
      await noteChild(sc, kid, `【父对话编译结果】编译通过：${result}\n你已经请父对话验收，等它收下，不用再做什么。`)
      tail.push(
        `子对话「${kid.title}」（id ${kid.id}）申请的编译通过了，它已经请你收尾、正在等你：核对它的收尾请求，没问题就调用 finish_child（id ${kid.id}）；要它补的用 send_to_conversation 交回。它不会自己再动。`,
      )
      continue
    }
    await sc
      .sendToChild(job.taskId, kid.id, `【父对话编译结果】${result}`, 'build', 'build', r.result === 'failed')
      .catch((e) => {
        log.warn('task', '编译结果推给子对话失败', { task: kid.id, error: (e as Error).message })
        sc.alertOn(kid.id, 'delivery', t('父对话的编译结果没能交给这个对话'), 'error')(e)
      })
  }
  return tail.length ? `\n\n${tail.join('\n')}` : ''
}

/** 在子对话里记一行面板消息，不开新的一轮（开新一轮会作废它的收尾请求） */
async function noteChild(sc: TasksScope, kid: Task, text: string) {
  const msg: TaskMessage = {
    id: randomUUID(),
    role: 'system',
    agentId: '',
    step: '',
    text,
    tools: [],
    panel: 'build',
    at: new Date().toISOString(),
  }
  kid.messages.push(msg)
  const entry = sc.live.get(kid.id)
  if (entry) entry.rev++
  await sc.store.update(kid.id, kid)
}
