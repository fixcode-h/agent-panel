import { Hono } from 'hono'
import { BUILTIN_HOOKS, builtinOn, builtinParam, HookEventName, type HookDefInput } from '../../shared/hook-defs.ts'
import { CLIS } from '../../shared/clis.ts'
import { hookEventsFor } from '../../shared/hooks.ts'
import { t } from '../../shared/i18n.ts'
import {
  deleteHook,
  migrateWebhook,
  orderHooks,
  putHook,
  readHooks,
  setBuiltin,
  setBuiltinParam,
  setProjectBuiltin,
} from './store.ts'
import { watchTaskEvents } from './notify.ts'
import { onTaskChange } from '../task-store.ts'
import { getSettings } from '../settings.ts'
import { log } from '../log.ts'
import { recentTriggers, runHook } from './run.ts'
import { checkHook, sampleInput } from './validate.ts'

/**
 * 设置页「钩子」的接口（ADR 0049 第二期）：列表、内置钩子开关、用户钩子增删改排序、校验、试跑、最近触发。
 * 保存前一律过 checkHook：语法、密钥、字段搭配不对就拒绝（AI 生成的提案也走这里）。
 * 给了 deps 时顺带接上只通知的面板事件（task.*，见 notify.ts）、把设置里原来的「计划 Webhook」迁成钩子
 */
export function hooksApi(deps?: {
  projects: { get: (id: string) => Promise<{ path: string } | null> }
  agents: { list: () => Promise<{ id: string; name: string }[]> }
}) {
  if (deps) {
    onTaskChange(
      watchTaskEvents({
        projectPath: async (id) => (await deps.projects.get(id))?.path ?? '',
        agentName: async (id) => (await deps.agents.list()).find((a) => a.id === id)?.name ?? '',
      }),
    )
    void getSettings()
      .then((s) => migrateWebhook(s.webhook))
      .catch((e: Error) => log.warn('hooks', '计划 Webhook 没能迁成钩子', { error: e.message }))
  }
  return new Hono()
    .get('/', async (c) => {
      const data = await readHooks()
      // 带了 projectId 时 on 是这个项目实际用的值，projectOn 是这个项目单独设的（没设为 null，跟着全局）
      const projectId = c.req.query('projectId') ?? ''
      return c.json({
        builtins: BUILTIN_HOOKS.map((h) => ({
          id: h.id,
          event: h.event,
          name: h.name(),
          description: h.description(),
          defaultOn: h.defaultOn,
          on: builtinOn(data, h, projectId),
          globalOn: builtinOn(data, h),
          projectOn: projectId ? (data.projects[projectId]?.[h.id] ?? null) : null,
          params: (h.params ?? []).map((p) => ({
            key: p.key,
            kind: p.kind,
            label: p.label(),
            hint: p.hint(),
            value: builtinParam(data, h, p.key),
          })),
        })),
        hooks: data.hooks,
        // 每个 CLI 支持哪些事件：界面上把不支持的灰掉、写明原因
        // 只通知的面板事件由面板自己发，每个 CLI 都算支持
        support: CLIS.map((x) => ({ id: x.id, name: x.name, events: hookEventsFor(x.hooks) })),
      })
    })
    .put('/builtins/:id', async (c) => {
      const h = BUILTIN_HOOKS.find((x) => x.id === c.req.param('id'))
      if (!h) return c.json({ error: t('没有这个内置钩子') }, 404)
      const body = (await c.req.json().catch(() => ({}))) as { on?: unknown; projectId?: unknown }
      // 带 projectId 是这个项目单独的开关；on 为 null 表示去掉单独的设置、跟着全局
      if (typeof body.projectId === 'string' && body.projectId)
        await setProjectBuiltin(body.projectId, h.id, body.on === null ? null : body.on === true)
      else await setBuiltin(h.id, body.on === true, h.defaultOn)
      return c.json({ ok: true })
    })
    .put('/builtins/:id/params', async (c) => {
      const h = BUILTIN_HOOKS.find((x) => x.id === c.req.param('id'))
      const body = (await c.req.json().catch(() => ({}))) as { key?: unknown; value?: unknown }
      const p = h?.params?.find((x) => x.key === body.key)
      if (!h || !p) return c.json({ error: t('没有这个参数') }, 404)
      const value =
        p.kind === 'number'
          ? Number(body.value)
          : (Array.isArray(body.value) ? body.value : [])
              .map((x) => String(x).trim())
              .filter(Boolean)
              .slice(0, 50)
      if (p.kind === 'number' && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100))
        return c.json({ error: t('要是 1 到 100 之间的整数') }, 400)
      const isDefault = JSON.stringify(value) === JSON.stringify(p.default)
      await setBuiltinParam(h.id, p.key, value, isDefault)
      return c.json({ ok: true })
    })
    .post('/check', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { def?: HookDefInput; run?: boolean }
      if (!body.def) return c.json({ error: t('没有钩子定义') }, 400)
      const r = await checkHook(body.def, { run: !!body.run })
      return c.json({ errors: r.errors, warnings: r.warnings })
    })
    .post('/test', async (c) => {
      // 试跑：用示例输入跑一次（可以改输入），显示原始输出和面板读出来的决定；不用先保存
      const body = (await c.req.json().catch(() => ({}))) as { def?: HookDefInput; input?: unknown }
      if (!body.def) return c.json({ error: t('没有钩子定义') }, 400)
      const r = await checkHook(body.def)
      if (!r.def) return c.json({ errors: r.errors }, 400)
      const input = { ...sampleInput(r.def.event), ...(body.input && typeof body.input === 'object' ? body.input : {}) }
      const run = await runHook(
        { ...r.def, enabled: true },
        { ...input, event: r.def.event },
        process.cwd(),
        r.def.action.type === 'command' ? r.def.action.script : undefined,
      )
      return c.json({ input, ...run, errors: r.errors, warnings: r.warnings })
    })
    .get('/triggers', (c) => c.json(recentTriggers()))
    .post('/order', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
      await orderHooks(Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [])
      return c.json({ ok: true })
    })
    .post('/', async (c) => save(c, ''))
    .put('/:id', async (c) => save(c, c.req.param('id')))
    .delete('/:id', async (c) => {
      await deleteHook(c.req.param('id'))
      return c.json({ ok: true })
    })
}

async function save(c: { req: { json: () => Promise<unknown> }; json: (b: unknown, s?: 400) => Response }, id: string) {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as HookDefInput
  if (!HookEventName.safeParse(body.event).success) return c.json({ errors: [t('事件不对')] }, 400)
  const r = await checkHook(body)
  if (r.errors.length) return c.json({ errors: r.errors, warnings: r.warnings }, 400)
  const def = await putHook({ ...body, id: id || body.id || '' })
  return c.json({ hook: def, warnings: r.warnings })
}
