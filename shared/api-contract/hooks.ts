/**
 * 设置页「钩子」的接口契约（写法见 ./define.ts；服务端 server/hooks/api.ts，演示 web/src/lib/demo/demo-hooks.ts）。
 * 钩子定义本身的校验在 checkHook（语法、密钥、字段搭配），出错要回成 { errors } 给界面逐条显示，
 * 所以请求体里的 def 只查「是个对象」，不在契约这一层用 HookDef 拦成一句报错
 */
import { z } from 'zod'
import { HOOK_TIERS } from '../hooks/builtins.ts'
import { HookDef, HookEventName, type HookDefInput } from '../hooks/defs.ts'
import { endpoint, shaped } from './define.ts'
import { MODEL_TIER_NAMES } from '../models/catalog.ts'
import { SUPPORT_KEYS } from '../models/support.ts'

const Tier = z.enum(HOOK_TIERS)
const Ok = z.object({ ok: z.literal(true) })
/** 钩子定义按界面编辑时的样子（z.input）传，服务端 checkHook 再逐项查 */
const DefInput = shaped<HookDefInput>(z.looseObject({}))
const ParamValue = z.union([z.array(z.string()), z.number()])
const TierName = z.enum(MODEL_TIER_NAMES)
const SupportKeyName = z.enum(SUPPORT_KEYS)
const SupportValue = z.union([z.string(), z.number()])

export const BuiltinHookView = z.object({
  id: z.string(),
  event: HookEventName,
  name: z.string(),
  description: z.string(),
  defaultOn: z.boolean(),
  /** 从哪一档开始开；老的服务端没有 */
  tier: Tier.optional(),
  /** 这一层按档位该是什么（不看逐个改过的） */
  tierOn: z.boolean().optional(),
  /** 实际用的值：看的是某个项目时按那个项目算 */
  on: z.boolean(),
  globalOn: z.boolean(),
  /** 这个项目单独设的开关；没设（跟着全局）为 null */
  projectOn: z.boolean().nullable(),
  params: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(['list', 'number']),
      label: z.string(),
      hint: z.string(),
      value: ParamValue,
    }),
  ),
})

/** 开着的插件带的钩子：只能开关 */
export const PluginHookView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  event: HookEventName,
  /** 插件名 */
  plugin: z.string(),
  on: z.boolean(),
})

export const HooksView = z.object({
  builtins: z.array(BuiltinHookView),
  /** 全局档位、这个项目选的档位（没选为 null）、这一层逐个改过几个；老的服务端没有 */
  tier: Tier.optional(),
  projectTier: Tier.nullable().optional(),
  tierChanged: z.number().optional(),
  hooks: z.array(HookDef),
  /** 老的服务端、演示后端没有这个字段 */
  plugins: z.array(PluginHookView).optional(),
  support: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** 本机检测到的版本；没检测到为空 */
      version: z.string().optional(),
      events: z.array(HookEventName),
      /** 本机版本太老、装不上的事件和要多少版本 */
      tooOld: z.array(z.object({ event: HookEventName, min: z.string() })),
    }),
  ),
  /** 按 CLI 关掉的事件 */
  cliOff: z.record(z.string(), z.array(HookEventName)),
  /** 按模型档位加强扶持（shared/models/support.ts 的 supportView）；老的服务端没有 */
  modelSupport: z
    .object({
      enabled: z.boolean(),
      items: z.array(
        z.object({
          key: SupportKeyName,
          label: z.string(),
          hint: z.string(),
          kind: z.enum(['choice', 'number']),
          choices: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
          min: z.number().optional(),
          max: z.number().optional(),
          values: z.record(TierName, SupportValue),
          defaults: z.record(TierName, SupportValue),
        }),
      ),
    })
    .optional(),
})

export const HookCheckView = z.object({ errors: z.array(z.string()), warnings: z.array(z.string()) })

export const HookTestView = HookCheckView.extend({
  input: z.unknown(),
  out: z
    .object({
      block: z.boolean().optional(),
      deny: z.boolean().optional(),
      reason: z.string().optional(),
      context: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
  ms: z.number(),
})

export const HookTriggerView = z.object({
  at: z.string(),
  hookId: z.string(),
  name: z.string(),
  event: z.string(),
  taskId: z.string(),
  result: z.enum(['none', 'block', 'deny', 'context', 'error']),
  detail: z.string(),
  ms: z.number(),
})

const Saved = z.object({ hook: HookDef, warnings: z.array(z.string()) })

export const hooksContract = {
  /** 查询参数 projectId：带了时 on 按这个项目实际用的值算 */
  list: endpoint({ method: 'GET', path: '/hooks', res: HooksView }),
  /** projectId 给了是这个项目单独的开关；on 为 null 去掉单独的设置 */
  setBuiltin: endpoint({
    method: 'PUT',
    path: '/hooks/builtins/:id',
    body: z.object({ on: z.boolean().nullable(), projectId: z.string().optional() }),
    res: Ok,
  }),
  /** projectId 给了是这个项目的档位；tier 为 null 表示项目跟随全局（只有项目层能选） */
  setTier: endpoint({
    method: 'PUT',
    path: '/hooks/tier',
    body: z.object({ tier: Tier.nullable(), projectId: z.string().optional() }),
    res: Ok,
  }),
  setPlugin: endpoint({ method: 'PUT', path: '/hooks/plugins/:id', body: z.object({ on: z.boolean() }), res: Ok }),
  setCliOff: endpoint({
    method: 'PUT',
    path: '/hooks/cli-off/:cli',
    body: z.object({ events: z.array(HookEventName) }),
    res: Ok,
  }),
  setParam: endpoint({
    method: 'PUT',
    path: '/hooks/builtins/:id/params',
    body: z.object({ key: z.string(), value: ParamValue }),
    res: Ok,
  }),
  /** 按模型档位加强扶持：enabled 改总开关；tier + key 改一格，value 为 null 回到默认 */
  setModelSupport: endpoint({
    method: 'PUT',
    path: '/hooks/model-support',
    body: z.object({
      enabled: z.boolean().optional(),
      tier: TierName.optional(),
      key: SupportKeyName.optional(),
      value: SupportValue.nullable().optional(),
    }),
    res: Ok,
  }),
  /** run：顺带真跑一次语法检查 */
  check: endpoint({
    method: 'POST',
    path: '/hooks/check',
    body: z.object({ def: DefInput, run: z.boolean().optional() }),
    res: HookCheckView,
  }),
  /** 试跑：用示例输入（可以覆盖）跑一次，不用先保存 */
  test: endpoint({
    method: 'POST',
    path: '/hooks/test',
    body: z.object({ def: DefInput, input: z.unknown().optional() }),
    res: HookTestView,
  }),
  create: endpoint({ method: 'POST', path: '/hooks', body: DefInput, res: Saved }),
  update: endpoint({ method: 'PUT', path: '/hooks/:id', body: DefInput, res: Saved }),
  remove: endpoint({ method: 'DELETE', path: '/hooks/:id', res: Ok }),
  order: endpoint({ method: 'POST', path: '/hooks/order', body: z.object({ ids: z.array(z.string()) }), res: Ok }),
  triggers: endpoint({ method: 'GET', path: '/hooks/triggers', res: z.array(HookTriggerView) }),
}
