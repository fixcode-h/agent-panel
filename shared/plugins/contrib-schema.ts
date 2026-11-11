import { z } from 'zod'
import { ToolKind } from '../hook-defs.ts'
import { TestStepShape } from '../schema.ts'

/**
 * 插件清单里的三段扩展（插件接口 3）的格式：钩子、测试步骤、「/」命令。
 * 只放 zod 定义（清单校验用），按开着的插件现取的逻辑在 contrib.ts
 */

/** 清单里的 id：小写字母、数字、连字符，拼进面板里的 id（plugin:<插件>:<id>）不会和别的撞 */
const LocalId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)

/** 插件能挂的钩子事件：只挂 CLI 的四个事件（能影响这一轮的），只通知的面板事件插件用不上 */
export const PLUGIN_HOOK_EVENTS = ['turn.beforeEnd', 'tool.before', 'tool.after', 'context.restored'] as const

/**
 * 插件带的钩子：输入输出和用户钩子同一套统一格式（shared/hook-defs.ts 的 HookInput / HookOutput）。
 * 写了 script 就用面板的 Node 跑包里的脚本（stdin 进 JSON、stdout 出 JSON，和用户的脚本钩子一样）；
 * 没写交给插件服务端入口的 hook(id, input)（插件进程里已经连着引擎、桥接时用这个，比如写入后编译）。
 * 插件打开就生效（用户已经信任了它的代码），设置 →「钩子」里可以单独关掉某一个
 */
export const PluginHook = z.object({
  id: LocalId,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  event: z.enum(PLUGIN_HOOK_EVENTS),
  match: z
    .object({
      tool: ToolKind.default('any'),
      path: z.string().trim().max(200).default(''),
      command: z.string().trim().max(200).default(''),
    })
    .default({ tool: 'any', path: '', command: '' }),
  /** 包里的 Node 脚本（相对包根）；不写交给服务端入口的 hook() */
  script: z.string().trim().max(200).optional(),
  /** 编译这类慢操作要比用户钩子的 60 秒上限长：插件钩子最多 10 分钟 */
  timeoutSec: z.number().int().min(1).max(600).default(30),
  onError: z.enum(['allow', 'deny']).default('allow'),
})
export type PluginHook = z.infer<typeof PluginHook>

/**
 * 插件带的测试步骤：字段和项目的测试步骤一样（同一个 TestStepShape），按改动筛、谁来跑的规则也一样。
 * 命令里的 {config.<参数>} 换成插件参数的当前值（引擎路径这类本机路径写在插件参数里，不写死在清单里）。
 * detect 是项目根目录下要有的文件（glob，例如 *.uproject）：写了就只在这类项目里生效，免得 UE 的编译步骤出现在网页项目里
 */
export const PluginTestStep = TestStepShape.extend({
  id: LocalId,
  detect: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
})
export type PluginTestStep = z.infer<typeof PluginTestStep>

/**
 * 插件带的「/」命令：md 文件在包里（front matter 和「所有 Agent」的命令同一种写法，$ARGUMENTS 换成参数），
 * 对哪个 CLI 都由面板展开，和「所有 Agent」的命令一样
 */
export const PluginCommand = z.object({
  name: z.string().regex(/^[A-Za-z0-9][\w:.-]{0,59}$/),
  description: z.string().trim().max(200).default(''),
  hint: z.string().trim().max(120).optional(),
  file: z.string().trim().min(1).max(200),
})
export type PluginCommand = z.infer<typeof PluginCommand>
