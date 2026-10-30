import { agentRun, cliSettings, defaultCli } from '../../shared/settings.ts'
import { getCli } from '../../shared/clis.ts'
import { getSettings } from '../settings.ts'
import { stopHelper, stopPlan } from '../../shared/engine.ts'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { childEnv, isProcessAlive, killTree } from '../exec/process.ts'
import { trackedClis, untrackCliProcess } from '../exec/orphans.ts'
import {
  HISTORY_CAPACITY,
  SAMPLE_INTERVAL_MS,
  buildSuggestPrompt,
  cleanableClis,
  loadHistory,
  processSnapshot,
  summarize,
} from '../exec/proc-stats.ts'
import { extractJson } from '../../shared/assist.ts'
import { invokeCli } from '../exec/invoke.ts'
import { tmpdir } from 'node:os'
import type { TasksScope } from './scope.ts'

/**
 * 停子任务和后台命令、看后台命令输出、对话名下的进程（列出、结束、清理残留、AI 建议）和内存曲线。
 */
export function registerProcessRoutes(sc: TasksScope) {
  /**
   * 终止对话派出的一个子任务（界面上的终止按钮）：还在跑的结束它的 CLI，还在排队的不再开始，
   * 按「已终止」交回给派它的对话；对话本身、别的子任务都不动
   */
  sc.routes.post('/:id/subtasks/stop', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const stepId = typeof body?.step === 'string' ? body.step : ''
    const tk = await sc.current(id)
    if (!tk) return sc.bad(c, t('任务不存在'), 404)
    // 「停止全部子任务」（用户让 AI 停、或脚本调）：还没结束的一个个停，已经结束的 stopHelper 会跳过
    if (body?.all === true) {
      const stopped = tk.steps
        .filter((s) => s.slot === 'sub' && stopHelper(id, s.id, '用户要求终止全部子任务'))
        .map((s) => s.id)
      if (stopped.length) log.info('task', '终止了全部子任务', { task: id, n: stopped.length })
      return c.json({ stopped: stopped.length })
    }
    const step = tk.steps.find((s) => s.id === stepId && s.slot === 'sub')
    if (!step) return sc.bad(c, t('找不到这个子任务'), 404)
    if (!stopHelper(id, step.id, '用户在界面上终止了这个子任务')) {
      // 界面上还画成在跑 / 没开始，面板里却已经没有在跑的它（异常退出、面板重启、派它的那一轮已经收尾）：
      // 直接收口成已终止，不再回「已经结束了」让它一直转圈
      if (!(await settleOrphanHelper(id, step.id))) return sc.bad(c, t('这个子任务已经结束了'), 409)
      log.warn('task', '终止的子任务已经没有在跑，直接收口成已终止', { task: id, step: step.id })
      return c.json(await sc.current(id))
    }
    log.info('task', '用户终止了子任务', { task: id, step: step.id })
    return c.json(await sc.current(id))
  })

  /**
   * 终止对话里正在跑的工作流（工作流卡片上的终止按钮）：只停这次运行，不停对话；
   * 对话收到「工作流被终止」和这次运行改了哪些文件，由它决定保留还是清理
   */
  sc.routes.post('/:id/runs/stop', async (c) => {
    const id = c.req.param('id')
    if (!(await sc.current(id))) return sc.bad(c, t('任务不存在'), 404)
    if (!stopPlan(id, '用户在界面上终止了这次工作流运行')) return sc.bad(c, t('这次工作流运行已经结束了'), 409)
    log.info('task', '用户终止了工作流运行', { task: id })
    return c.json(await sc.current(id))
  })

  /**
   * 没有在跑却还标着执行中 / 没开始的子任务：落成已终止并保存。已经有结论（完成、失败、终止）的不动，返回 false
   */
  async function settleOrphanHelper(id: string, stepId: string) {
    const e = sc.live.get(id)
    const tk = e?.task ?? (await sc.store.get(id))
    const s = tk?.steps.find((x) => x.id === stepId && x.slot === 'sub')
    if (!tk || !s || (s.status !== 'running' && s.status !== 'pending')) return false
    s.status = 'skipped'
    s.interrupted = false
    delete s.apiWait
    s.endedAt = new Date().toISOString()
    tk.updatedAt = s.endedAt
    if (e) e.rev++
    await sc.store.update(tk.id, tk)
    return true
  }

  /** 停止这个对话和它名下子对话的全部后台命令（对话本身不停）；返回停了几条 */
  sc.routes.post('/:id/background/stop', async (c) => {
    const id = c.req.param('id')
    if (!(await sc.current(id))) return sc.bad(c, t('任务不存在'), 404)
    const kids = (await sc.store.list()).filter((x) => x.parentTaskId === id)
    const before = [id, ...kids.map((k) => k.id)].reduce(
      (n, tid) => n + sc.background.list(tid).filter((j) => j.state === 'queued' || j.state === 'running').length,
      0,
    )
    await sc.endBackground(id)
    return c.json({ stopped: before })
  })

  /**
   * 一条后台命令的当前输出：界面上点命令行那一行标题打开的终端窗口按它轮询。
   * 命令结束后仍然读得到最终输出（用户可能过一阵才点开）；只认这个对话自己的命令，跨对话读别人的当不存在
   */
  sc.routes.get('/:id/jobs/:jobId', async (c) => {
    const id = c.req.param('id')
    if (!(await sc.current(id))) return sc.bad(c, t('任务不存在'), 404)
    const job = sc.background.view(id, c.req.param('jobId'))
    if (!job) return sc.bad(c, t('没有这条后台命令'), 404)
    return c.json(job)
  })

  /** 这个对话的进程列表和内存合计：标题栏下拉展开时才拉，收起时不请求 */
  sc.routes.get('/:id/processes', async (c) => {
    const tk = await sc.current(c.req.param('id'))
    if (!tk) return sc.bad(c, t('任务不存在'), 404)
    return c.json(await sc.processPanel(tk))
  })

  /** 关闭一个进程：只认这个对话进程树上的 pid，面板自己和用户自己开的进程都进不来 */
  sc.routes.post('/:id/processes/:pid/kill', async (c) => {
    const tk = await sc.current(c.req.param('id'))
    if (!tk) return sc.bad(c, t('任务不存在'), 404)
    const pid = Number(c.req.param('pid'))
    if (!Number.isInteger(pid) || pid <= 0) return sc.bad(c, t('进程号不对'))
    const allowed = await sc.allowedPids(await sc.subtreeIdsOf(tk))
    if (!allowed.has(pid)) return sc.bad(c, t('这个进程不属于当前对话，不能从这里关闭'))
    killTree(pid)
    // 等一下再看：结束失败（权限不足、被系统占用）要把真实状态告诉用户，不能悄悄把登记删掉
    await new Promise((r) => setTimeout(r, 1200))
    if (isProcessAlive(pid)) return c.json({ ok: false, pid, error: t('进程还在，可能权限不足或被系统占用，稍后再试') })
    // 登记还在的话，下次刷新会显示成「已结束」：先去掉，界面只反映还活着的
    untrackCliProcess(pid)
    log.info('exec', '从进程面板关闭进程', { task: tk.id, pid })
    return c.json({ ok: true, pid, error: '' })
  })

  /**
   * 清理无效进程：只清面板登记过、任务已经不在跑的（登记残留）。
   * 用户确认列表里的 pid 传进来就只清这些；传空时清这个对话的全部残留
   */
  sc.routes.post('/:id/processes/clean', async (c) => {
    const tk = await sc.current(c.req.param('id'))
    if (!tk) return sc.bad(c, t('任务不存在'), 404)
    const body = (await c.req.json().catch(() => ({}))) as { pids?: unknown }
    const only = Array.isArray(body.pids) ? body.pids.filter((x): x is number => Number.isInteger(x)) : []
    const ids = await sc.subtreeIdsOf(tk)
    const map = await processSnapshot()
    const { targets, skipped, gone } = cleanableClis({
      entries: trackedClis(),
      map,
      aliveTask: sc.taskAlive,
      taskIds: ids,
      only,
    })
    // 进程已经不在的登记顺手清掉（不算「结束」，界面照样显示成已结束）
    for (const pid of gone) untrackCliProcess(pid)
    for (const e of targets) killTree(e.pid)
    // 只把真的结束了的从登记里去掉；没结束的留在列表里并说明原因，用户可以再试
    if (targets.length) await new Promise((r) => setTimeout(r, 1200))
    const killed: number[] = []
    for (const e of targets) {
      if (isProcessAlive(e.pid)) {
        skipped.push({ pid: e.pid, reason: t('进程没有结束（可能权限不足）') })
        continue
      }
      killed.push(e.pid)
      untrackCliProcess(e.pid)
    }
    if (killed.length || gone.length) log.info('exec', '清理无效进程', { task: tk.id, 清理: killed, 登记残留: gone })
    return c.json({ killed, skipped, gone })
  })

  /**
   * AI 清理建议：把进程列表交给本机的 CLI，让它指出可以关掉的项和理由。
   * 只给建议，不杀任何进程；用户确认后前端再调清理接口
   */
  sc.routes.post('/:id/processes/suggest', async (c) => {
    const tk = await sc.current(c.req.param('id'))
    if (!tk) return sc.bad(c, t('任务不存在'), 404)
    const panel = await sc.processPanel(tk)
    const settings = await getSettings()
    const cliId = defaultCli(settings)
    const def = getCli(cliId)
    if (!def) return sc.bad(c, t('没有可用的 Agent'))
    const cs = cliSettings(settings, cliId)
    const run = agentRun({ cli: cliId, model: '', effort: '' }, settings)
    const cwd = path.join(tmpdir(), 'agent-panel-process-review')
    await mkdir(cwd, { recursive: true })
    let text = ''
    const r = await invokeCli({
      cliId,
      command: cs.command,
      build: {
        model: run.model,
        effort: run.effort,
        // 只是看进程列表做判断，用 CLI 自己的只读权限
        permission: def.readOnly || cs.permission,
        extraArgs: cs.extraArgs,
      },
      cwd,
      env: childEnv(cs.env),
      input: buildSuggestPrompt(panel),
      timeoutMs: 120_000,
      onEvent: (ev) => {
        if (ev.type === 'text' || ev.type === 'text_delta') text += ev.text
      },
    })
    if (r.spawnError) return c.json({ suggestions: [], text: '', error: r.spawnError })
    const parsed = extractJson(text) as { kill?: unknown } | undefined
    const allowed = await sc.allowedPids(await sc.subtreeIdsOf(tk))
    const suggestions = (Array.isArray(parsed?.kill) ? parsed.kill : [])
      .map((x) => x as { pid?: unknown; reason?: unknown })
      .filter((x) => Number.isInteger(x.pid) && allowed.has(Number(x.pid)))
      .map((x) => ({ pid: Number(x.pid), reason: String(x.reason ?? '').slice(0, 200) }))
    // 没有解析出 JSON：把 CLI 的原文交给界面，用户自己看
    return c.json({ suggestions, text: text.slice(0, 4000), error: '' })
  })

  /** 内存曲线：按时间从旧到新，from/to 是 epoch ms（不传就是全部历史） */
  sc.routes.get('/:id/memory', async (c) => {
    const tk = await sc.current(c.req.param('id'))
    if (!tk) return sc.bad(c, t('任务不存在'), 404)
    const from = Number(c.req.query('from') ?? '')
    const to = Number(c.req.query('to') ?? '')
    const points = summarize(loadHistory(), await sc.subtreeIdsOf(tk), {
      from: Number.isFinite(from) && from > 0 ? from : undefined,
      to: Number.isFinite(to) && to > 0 ? to : undefined,
    })
    return c.json({ sampledAt: Date.now(), intervalMs: SAMPLE_INTERVAL_MS, capacity: HISTORY_CAPACITY, points })
  })
}
