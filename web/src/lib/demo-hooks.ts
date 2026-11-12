import {
  BUILTIN_HOOKS,
  HookDef,
  builtinOn,
  builtinParam,
  checkOutput,
  tierChanged,
  tierOn,
  type HookDefInput,
  type HookTier,
} from '@shared/hook-defs'
import { CLIS } from '@shared/clis'
import { hookEventsFor } from '@shared/hooks'
import { t } from '@shared/i18n'

/**
 * 在线演示里的「钩子」：内置钩子开关、用户钩子的增删改都存在浏览器内存里；
 * 校验只查形状（演示里没有 Node 可以做语法检查、试跑），试跑返回一个按事件编的示例结果
 */
let builtins: Record<string, boolean> = {}
// 演示里不分项目：档位只有全局一份
let tier: HookTier = 'standard'
const cliOff: Record<string, string[]> = {}
// 内置钩子的参数；演示里不分项目，按项目的开关也当成全局的
const params: Record<string, Record<string, string[] | number>> = {}
let hooks: HookDef[] = [
  HookDef.parse({
    id: 'demo-lock',
    name: '锁文件不要手改',
    description: '改 package-lock.json 这类锁文件时拒绝，让它用包管理器的命令',
    event: 'tool.before',
    match: { tool: 'edit', path: '**/*-lock.json', command: '' },
    action: {
      type: 'command',
      script:
        "let raw = ''\nprocess.stdin.on('data', (c) => (raw += c)).on('end', () => {\n  process.stdout.write(JSON.stringify({ deny: true, reason: '锁文件不要手改：用 npm install 更新' }))\n})\n",
    },
    enabled: true,
  }),
]

function check(def: HookDefInput) {
  const p = HookDef.safeParse({ ...def, id: def.id || 'demo' })
  if (!p.success) return { errors: p.error.issues.map((i) => `${i.path.join('.')}：${i.message}`), warnings: [] }
  const no = CLIS.filter((c) => !hookEventsFor(c.hooks).includes(p.data.event)).map((c) => c.name)
  return {
    errors: [] as string[],
    warnings: no.length ? [t('这些 CLI 不支持这个事件，在它们的对话里不会触发：{list}', { list: no.join('、') })] : [],
    def: p.data,
  }
}

export function demoHooks(method: string, seg: string[], body: unknown) {
  // seg[0] 是 'hooks'
  const [id, sub] = seg.slice(1)
  const b = (body ?? {}) as Record<string, unknown>
  if (method === 'GET' && !id)
    return {
      builtins: BUILTIN_HOOKS.map((h) => ({
        id: h.id,
        event: h.event,
        name: h.name(),
        description: h.description(),
        defaultOn: h.defaultOn,
        tier: h.tier,
        tierOn: tierOn(tier, h),
        on: builtinOn({ builtins, projects: {}, tier }, h),
        globalOn: builtinOn({ builtins, projects: {}, tier }, h),
        projectOn: null,
        params: (h.params ?? []).map((p) => ({
          key: p.key,
          kind: p.kind,
          label: p.label(),
          hint: p.hint(),
          value: builtinParam({ params }, h, p.key),
        })),
      })),
      tier,
      projectTier: null,
      tierChanged: tierChanged({ builtins, projects: {}, tier }),
      hooks,
      support: CLIS.map((c) => ({ id: c.id, name: c.name, events: hookEventsFor(c.hooks), tooOld: [] })),
      cliOff,
    }
  if (method === 'GET' && id === 'triggers')
    return [
      {
        at: new Date().toISOString(),
        hookId: 'demo-lock',
        name: '锁文件不要手改',
        event: 'tool.before',
        taskId: 'demo',
        result: 'deny',
        detail: '锁文件不要手改：用 npm install 更新',
        ms: 42,
      },
    ]
  if (id === 'tier') {
    tier = (b.tier as HookTier) ?? 'standard'
    builtins = {}
    return { ok: true }
  }
  if (id === 'cli-off' && sub) {
    cliOff[sub] = (b.events as string[]) ?? []
    return { ok: true }
  }
  if (id === 'builtins' && sub && seg[3] === 'params') {
    params[sub] = { ...params[sub], [String(b.key)]: b.value as string[] | number }
    return { ok: true }
  }
  if (id === 'builtins' && sub) {
    const h = BUILTIN_HOOKS.find((x) => x.id === sub)
    if (b.on !== null && h && (b.on === true) === tierOn(tier, h)) delete builtins[sub]
    else if (b.on !== null) builtins[sub] = b.on === true
    return { ok: true }
  }
  if (id === 'check') {
    const r = check((b.def ?? {}) as HookDefInput)
    return { errors: r.errors, warnings: r.warnings }
  }
  if (id === 'test') {
    const r = check((b.def ?? {}) as HookDefInput)
    if (!r.def) return { errors: r.errors, warnings: [], input: {}, ms: 0 }
    const sample =
      r.def.event === 'tool.before'
        ? { deny: true, reason: '（演示）这是一个示例结果' }
        : r.def.event === 'turn.beforeEnd'
          ? {}
          : { context: '（演示）这是一个示例说明' }
    const c = checkOutput(r.def.event, sample)
    return {
      errors: [],
      warnings: r.warnings,
      input: { event: r.def.event },
      ms: 12,
      ...('out' in c ? { out: c.out } : {}),
    }
  }
  if (id === 'order') {
    const ids = Array.isArray(b.ids) ? (b.ids as string[]) : []
    hooks = [...hooks].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id))
    return { ok: true }
  }
  if (method === 'DELETE' && id) {
    hooks = hooks.filter((h) => h.id !== id)
    return { ok: true }
  }
  if (method === 'POST' || method === 'PUT') {
    const r = check({ ...(b as HookDefInput), id: id || (b.id as string) || `demo-${Date.now().toString(36)}` })
    if (!r.def) throw Object.assign(new Error(r.errors.join('；')), { status: 400, body: r })
    const def = { ...r.def, updatedAt: new Date().toISOString() }
    hooks = hooks.some((h) => h.id === def.id) ? hooks.map((h) => (h.id === def.id ? def : h)) : [...hooks, def]
    return { hook: def, warnings: r.warnings }
  }
  throw new Error('演示里不支持这个操作')
}
