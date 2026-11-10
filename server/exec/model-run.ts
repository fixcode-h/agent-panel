/**
 * 一次调用用哪个思考强度、上下文窗口和最大输出，以及按模型查窗口：只算值、不碰任务。
 * 从 runner.ts 拆出来（文件行数上限，见 docs/lessons/file-caps.md），runAgent 拿结果拼启动参数
 */
import type { agentRun, cliSettings } from '../../shared/settings.ts'
import { autoLimits, type ModelLimits } from '../../shared/model-limits.ts'
import { apiModelInfo, apiModelKey } from '../../shared/model-catalog.ts'
import { mergedModelCatalog } from '../model-catalog-store.ts'
import { cachedModels, knownWindows, supportedEffort } from '../models.ts'

type Run = ReturnType<typeof agentRun>
type Cs = ReturnType<typeof cliSettings>
type Entries = Awaited<ReturnType<typeof mergedModelCatalog>>

/** 这一轮的思考强度（模型不认的已经换掉或去掉）和上下文上限 */
export async function resolveModelRun(cliId: string, run: Run, cs: Cs) {
  const model = run.model
  // 模型不认的思考强度会让 CLI 启动即报错退出：挡在这里，下面记下的启动命令和日志才和实际调用的参数一致
  // 模型目录里的默认思考强度：没有手动指定时用它；目录里没有的模型交给 CLI 自己决定
  const entries = await mergedModelCatalog().catch(() => [])
  // API 设置里给这个模型配了映射时，默认思考强度按映射到的模型算
  const catalogInfo = apiModelInfo(model, cs.api, entries)
  // API 设置里给这个模型配的默认思考强度优先，其次才是模型目录的默认值
  const defaultEffort =
    cs.api?.modelEfforts?.[apiModelKey(model, cs.api.modelEfforts)] ||
    (catalogInfo.matched ? catalogInfo.defaultEffort : '')
  const requested = run.effort || defaultEffort
  let effort = await supportedEffort(cliId, model, requested)
  // 模型不认 Agent 自己或档位给的强度时，再试档位 / 模型默认的强度，不能直接变成不传
  const fallback = (run.tier ? cs.tiers[run.tier.id].effort : '') || defaultEffort
  if (!effort && requested && fallback && fallback !== requested) effort = await supportedEffort(cliId, model, fallback)
  // 档位在设置里手动改过的上下文窗口和最大输出；0 是自动，用下面算出来的值
  const manual: ModelLimits = run.tier
    ? { context: cs.tiers[run.tier.id].context, maxOutput: cs.tiers[run.tier.id].maxOutput }
    : {}
  // 自动值也传给 CLI：Claude Code、Codex 只认全局的窗口（环境变量 / 配置），
  // 接第三方接口时模型不在它们认识的内置表里，不传就按默认窗口截断，压缩点会小很多。
  // 只传上下文：最大输出在它们那里也是全局的，按目录传会把这个 CLI 的所有模型都改成同一个值。
  // 目录里没有的模型不传，交给 CLI 自己判断
  const known = apiModelInfo(model, cs.api, entries)
  const limits: ModelLimits = {
    context: manual.context || (known.matched ? known.context : undefined),
    maxOutput: manual.maxOutput || undefined,
  }
  return { entries, requested, effort, manual, limits }
}

/** 按模型查上下文窗口：这一轮的模型有手动或目录里的窗口时直接用 */
export async function windowLookup(cliId: string, model: string, limits: ModelLimits, cs: Cs, entries: Entries) {
  // 只用已经读过的模型列表（设置页、Agent 页打开时会读），不为了查窗口再跑一次 CLI
  const catalog = cachedModels(cliId)?.models ?? []
  const files = await knownWindows(cliId)
  // 模型目录里没有时按 1M 估算；API 模式按当前接口的协议优先选
  return (m: string) => {
    if (m === model && limits.context) return limits.context
    // API 设置里给这个模型配了映射：按映射到的模型配置查；CLI 收到的模型名不受影响
    const key = cs.api?.modelMap?.[m] || m
    return (
      catalog.find((x) => x.id === key || x.id.endsWith(`/${key}`))?.contextWindow ??
      files.get(key) ??
      files.get(key.slice(key.lastIndexOf('/') + 1)) ??
      autoLimits(key, catalog, { entries, protocol: cs.api?.protocol }).context
    )
  }
}
