import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { HookEventName } from '../../shared/hooks/defs.ts'
import { hooksContract as H } from '../../shared/api-contract/hooks.ts'
import { BUILTIN_HOOKS, builtinOn, builtinParam, tierChanged, tierDefault } from '../../shared/hooks/builtins.ts'
import { CLIS } from '../../shared/clis.ts'
import { knownVersion } from '../detect.ts'
import { hookEventsFor } from '../../shared/hooks/index.ts'
import { t } from '../../shared/i18n.ts'
import {
  deleteHook,
  migrateWebhook,
  orderHooks,
  putHook,
  readHooks,
  setBuiltin,
  setBuiltinParam,
  setCliOff,
  setProjectBuiltin,
  setModelSupport,
  setTier,
} from './store.ts'
import { supportView } from '../../shared/models/support.ts'
import { watchTaskEvents } from './notify.ts'
import { onTaskChange } from '../tasks/store.ts'
import { getSettings } from '../settings.ts'
import { log } from '../log.ts'
import { recentTriggers, runHook } from './run.ts'
import { checkHook, sampleInput } from './validate.ts'
import { activePluginHooks } from '../plugins/contrib.ts'

/**
 * 设置页「钩子」的接口（ADR 0049 第二期）：列表、内置钩子开关、用户钩子增删改排序、校验、试跑、最近触发。
 * 保存前一律过 checkHook：语法、密钥、字段搭配不对就拒绝（AI 生成的提案也走这里）。
 * 入参按前后端共用的契约校验（shared/api-contract/hooks.ts），不对的回 400 和 zod 的说明。
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
          tier: h.tier,
          tierOn: tierDefault(data, h, projectId),
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
        // 档位：全局的、这个项目选的（没选为 null，跟着全局），和这一层逐个改过几个
        tier: data.tier,
        projectTier: projectId ? (data.projectTiers[projectId] ?? null) : null,
        tierChanged: tierChanged(data, projectId),
        hooks: data.hooks,
        // 开着的插件带的钩子（插件接口 3）：只能开关，定义跟着插件包走
        plugins: activePluginHooks(data).map((h) => ({
          id: h.id,
          name: h.name,
          description: h.description,
          event: h.event,
          plugin: h.plugin.name,
          on: h.enabled,
        })),
        // 每个 CLI 支持哪些事件：界面上把不支持的灰掉、写明原因
        // 只通知的面板事件由面板自己发，每个 CLI 都算支持
        support: CLIS.map((x) => ({
          id: x.id,
          name: x.name,
          version: knownVersion(x.id),
          events: hookEventsFor(x.hooks, knownVersion(x.id)),
          // 版本不够装不上的：设置页写明要多少版本
          tooOld: (['turn.beforeEnd', 'tool.before', 'tool.after', 'context.restored'] as const)
            .filter(
              (e) => hookEventsFor(x.hooks).includes(e) && !hookEventsFor(x.hooks, knownVersion(x.id)).includes(e),
            )
            .map((e) => ({
              event: e,
              min: (e === 'turn.beforeEnd' ? x.hooks?.beforeEnd?.minVersion : x.hooks?.events[e]?.minVersion) ?? '',
            })),
        })),
        // 按 CLI 关掉的事件
        cliOff: data.cliOff,
        modelSupport: supportView(data.modelSupport),
      })
    })
    .put('/builtins/:id', async (c) => {
      const h = BUILTIN_HOOKS.find((x) => x.id === c.req.param('id'))
      if (!h) return c.json({ error: t('没有这个内置钩子') }, 404)
      const p = await parse(c, H.setBuiltin.body)
      if (!p.ok) return p.res
      const { on, projectId } = p.data
      // 带 projectId 是这个项目单独的开关；on 为 null 表示去掉单独的设置、跟着全局
      if (projectId) await setProjectBuiltin(projectId, h.id, on)
      else await setBuiltin(h.id, on === true)
      return c.json({ ok: true })
    })
    .put('/tier', async (c) => {
      const p = await parse(c, H.setTier.body)
      if (!p.ok) return p.res
      const { tier, projectId = '' } = p.data
      // 只有项目层能选「跟着全局」（null）
      if (tier === null && !projectId) return c.json({ error: t('参数不对') }, 400)
      await setTier(tier, projectId)
      return c.json({ ok: true })
    })
    .put('/model-support', async (c) => {
      const p = await parse(c, H.setModelSupport.body)
      if (!p.ok) return p.res
      const error = await setModelSupport(p.data)
      return error ? c.json({ error }, 400) : c.json({ ok: true })
    })
    .put('/plugins/:id', async (c) => {
      // 插件钩子的开关：默认开，只记关掉的（和内置钩子同一份 builtins，键是 plugin:<插件>:<钩子>）
      const h = activePluginHooks(await readHooks()).find((x) => x.id === c.req.param('id'))
      if (!h) return c.json({ error: t('没有这个插件钩子，插件可能关掉了') }, 404)
      const p = await parse(c, H.setPlugin.body)
      if (!p.ok) return p.res
      await setBuiltin(h.id, p.data.on, true)
      return c.json({ ok: true })
    })
    .put('/cli-off/:cli', async (c) => {
      const p = await parse(c, H.setCliOff.body)
      if (!p.ok) return p.res
      if (!CLIS.some((x) => x.id === c.req.param('cli'))) return c.json({ error: t('参数不对') }, 400)
      await setCliOff(c.req.param('cli'), p.data.events)
      return c.json({ ok: true })
    })
    .put('/builtins/:id/params', async (c) => {
      const h = BUILTIN_HOOKS.find((x) => x.id === c.req.param('id'))
      const parsed = await parse(c, H.setParam.body)
      if (!parsed.ok) return parsed.res
      const body = parsed.data
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
      const p = await parse(c, H.check.body)
      if (!p.ok) return p.res
      const r = await checkHook(p.data.def, { run: !!p.data.run })
      return c.json({ errors: r.errors, warnings: r.warnings })
    })
    .post('/test', async (c) => {
      // 试跑：用示例输入跑一次（可以改输入），显示原始输出和面板读出来的决定；不用先保存
      const p = await parse(c, H.test.body)
      if (!p.ok) return p.res
      const body = p.data
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
      const p = await parse(c, H.order.body)
      if (!p.ok) return p.res
      await orderHooks(p.data.ids)
      return c.json({ ok: true })
    })
    .post('/', async (c) => save(c, ''))
    .put('/:id', async (c) => save(c, c.req.param('id')))
    .delete('/:id', async (c) => {
      await deleteHook(c.req.param('id'))
      return c.json({ ok: true })
    })
}

/** 按契约读请求体：读不出 JSON 按空对象算，不合契约回 400 */
async function parse<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.output<S> } | { ok: false; res: Response }> {
  const p = schema.safeParse(await c.req.json().catch(() => ({})))
  return p.success ? { ok: true, data: p.data } : { ok: false, res: c.json({ error: z.prettifyError(p.error) }, 400) }
}

async function save(c: Context, id: string) {
  const p = await parse(c, id ? H.update.body : H.create.body)
  if (!p.ok) return c.json({ errors: [t('没有钩子定义')] }, 400)
  const body = p.data
  if (!HookEventName.safeParse(body.event).success) return c.json({ errors: [t('事件不对')] }, 400)
  const r = await checkHook(body)
  if (r.errors.length) return c.json({ errors: r.errors, warnings: r.warnings }, 400)
  const def = await putHook({ ...body, id: id || body.id || '' })
  return c.json({ hook: def, warnings: r.warnings })
}
