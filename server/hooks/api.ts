import { Hono } from 'hono'
import { BUILTIN_HOOKS, builtinOn, HookEventName, type HookDefInput } from '../../shared/hook-defs.ts'
import { CLIS } from '../../shared/clis.ts'
import { supportedEvents } from '../../shared/hooks.ts'
import { t } from '../../shared/i18n.ts'
import { deleteHook, orderHooks, putHook, readHooks, setBuiltin } from './store.ts'
import { recentTriggers, runHook } from './run.ts'
import { checkHook, sampleInput } from './validate.ts'

/**
 * 设置页「钩子」的接口（ADR 0049 第二期）：列表、内置钩子开关、用户钩子增删改排序、校验、试跑、最近触发。
 * 保存前一律过 checkHook：语法、密钥、字段搭配不对就拒绝（AI 生成的提案也走这里）
 */
export function hooksApi() {
  return new Hono()
    .get('/', async (c) => {
      const data = await readHooks()
      return c.json({
        builtins: BUILTIN_HOOKS.map((h) => ({
          id: h.id,
          event: h.event,
          name: h.name(),
          description: h.description(),
          defaultOn: h.defaultOn,
          on: builtinOn(data, h),
        })),
        hooks: data.hooks,
        // 每个 CLI 支持哪些事件：界面上把不支持的灰掉、写明原因
        support: CLIS.map((x) => ({ id: x.id, name: x.name, events: supportedEvents(x.hooks) })),
      })
    })
    .put('/builtins/:id', async (c) => {
      const h = BUILTIN_HOOKS.find((x) => x.id === c.req.param('id'))
      if (!h) return c.json({ error: t('没有这个内置钩子') }, 404)
      const body = (await c.req.json().catch(() => ({}))) as { on?: unknown }
      await setBuiltin(h.id, body.on === true, h.defaultOn)
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
