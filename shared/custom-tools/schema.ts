/**
 * 自建工具（/createtool，设计稿 docs/openspec/changes/custom-tools/design.md，ADR 0082）的存盘格式。
 * 一个工具 = 一条命令（或一段脚本）+ 参数定义 + 给人和 Agent 看的中文说明。
 * 项目的存 文档根/AgentPanel/Tools/<id>.json（跟仓库走、团队共用），全局的存 <数据目录>/tools/<id>.json（只在本机）。
 * 前后端和演示后端共用这一份契约
 */
import { z } from 'zod'

/** 工具 id：英文短名，Agent 调用时用；也是文件名，所以只许小写字母数字和 - */
export const TOOL_ID = /^[a-z][a-z0-9-]{1,47}$/
/** 参数名：拼进 {{名字}} 占位符 */
export const PARAM_NAME = /^[a-z][a-z0-9_]{0,31}$/

export const ToolParam = z.object({
  name: z.string().regex(PARAM_NAME),
  /** 中文名：表单和授权卡上显示 */
  label: z.string().default(''),
  type: z.enum(['string', 'number', 'boolean', 'enum', 'path']).default('string'),
  desc: z.string().default(''),
  required: z.boolean().default(false),
  /** 没给时用的值（布尔写 true / false） */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** enum 的可选值 */
  options: z.array(z.string()).default([]),
  /** string 的格式（正则）；number 的范围 */
  pattern: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /**
   * 写成命令行开关：有值时展开成「flag 值」，布尔为真时只展开成 flag；没值、为假时连同 flag 一起去掉。
   * 不写时 {{名字}} 只换成值本身
   */
  flag: z.string().optional(),
  /** path：必须在项目目录里（拼出来的路径跳出项目就拒绝） */
  inProject: z.boolean().default(true),
})
export type ToolParam = z.infer<typeof ToolParam>

/** 影响：read 只读；write 改项目里的文件；external 影响外部（提交、上传、发消息、改服务器） */
export const ToolEffect = z.enum(['read', 'write', 'external'])
export type ToolEffect = z.infer<typeof ToolEffect>

export const ToolRun = z.object({
  /** 命令模板：{{参数名}} 和面板自带的 {{projectRoot}} {{workDir}} {{docRoot}} {{dataDir}} {{script}} */
  command: z.string().min(1),
  /** 按平台覆盖命令（Windows 上跑 .bat、其他系统跑 .sh 这种） */
  win: z.string().optional(),
  posix: z.string().optional(),
  /** 脚本正文：太长、一行写不下的命令放这里，运行前面板写成文件，命令里用 {{script}} 引用它的路径 */
  script: z.object({ ext: z.string().regex(/^[a-z0-9]{1,8}$/), text: z.string() }).optional(),
  /** 工作目录，相对项目根（独立分支里换成分支目录） */
  cwd: z.string().default('.'),
  timeoutSec: z
    .number()
    .int()
    .min(5)
    .max(8 * 3600)
    .default(600),
  /**
   * auto：限时不超过两分钟的在工具里等结果，更长的交给后台命令、跑完推回；always 一律后台；never 一律在工具里等
   */
  background: z.enum(['auto', 'always', 'never']).default('auto'),
})
export type ToolRun = z.infer<typeof ToolRun>

export const ToolOutput = z.object({
  /** 算成功的退出码 */
  okExit: z.array(z.number().int()).default([0]),
  /** 报错行的正则：命名分组 file、line、msg（都可选），匹配上的列进结果的「报错」 */
  errorPattern: z.string().optional(),
})

/**
 * 工具在能力路由里的用途（ADR 0086）：不写就照旧只在工具表里、由 Agent 自己调。
 * - verify：能力「校验」的一条路。Agent 改了对得上 paths 的文件、去做别的事时面板自己跑它，只把报错推回去；
 *   要求只读（effect: read），因为面板自己跑、不弹授权卡；
 * - build：能力「改动生效」的一条路（项目自己的编译脚本），Agent 自己拼编译命令时指到它。
 * replaces：Agent 自己跑这些程序（如 luac）时，改道模式下改走这个工具；观察模式只记「会改到哪」
 */
export const ToolRole = z.object({
  kind: z.enum(['verify', 'build']),
  /** verify：改了哪些文件要跑它（相对项目根的通配，** 任意层），例如 **∕*.lua */
  paths: z.array(z.string()).default([]),
  /** 认作同一件事的程序名（小写、不带 .exe），例如 luac */
  replaces: z.array(z.string()).default([]),
  /** 改过的文件填进哪个参数；不写用第一个 path 类型的参数，没有就不带文件跑一次 */
  arg: z.string().optional(),
  /** 改过的文件写成清单文件（一行一个）再把清单路径填进参数：一次查完，不按文件一个个跑 */
  listFile: z.boolean().default(false),
})
export type ToolRole = z.infer<typeof ToolRole>

export const ToolVersion = z.object({
  version: z.number().int(),
  at: z.string(),
  by: z.string().default(''),
  /** 这一版的命令和参数名（看差异用，不存全量） */
  command: z.string().default(''),
  note: z.string().default(''),
})

export const CustomTool = z.object({
  schema: z.literal(1).default(1),
  id: z.string().regex(TOOL_ID),
  /** 中文名 */
  name: z.string().min(1),
  summary: z.string().default(''),
  useWhen: z.string().default(''),
  avoidWhen: z.string().default(''),
  tags: z.array(z.string()).default([]),
  run: ToolRun,
  params: z.array(ToolParam).default([]),
  effect: ToolEffect.default('write'),
  /**
   * Agent 调用前要不要先弹授权卡问用户。用户 2026-11-26：自建工具是用户自己存下、看过的命令，默认和普通工具一样直接跑；
   * 个别想每次过目的（发版、上传这类）在管理页的「影响和输出」里打开。还没保存的草稿试跑不看这一项，总是问
   */
  confirm: z.boolean().default(false),
  /** 会改的文件（相对项目根的通配，** 任意层）：执行前在 P4 里签出，授权卡上写出来 */
  writes: z.array(z.string()).default([]),
  output: ToolOutput.default({ okExit: [0] }),
  /** 属于能力路由的哪个能力（ADR 0081），例如 apply-change:lua；路由接上之前只是标记 */
  capability: z.string().optional(),
  /** 在能力路由里的用途（校验、编译）；可选字段，旧文件没有它照常读 */
  role: ToolRole.optional(),
  /** 从哪些文件总结出来的（相对项目根） */
  sources: z.array(z.string()).default([]),
  version: z.number().int().min(1).default(1),
  /** 这一版改了什么（保存时填的；版本记录里显示） */
  note: z.string().default(''),
  /** 最近几个旧版本（最多 5 个） */
  history: z.array(ToolVersion).default([]),
  createdBy: z.string().default(''),
  updatedAt: z.string().default(''),
})
export type CustomTool = z.infer<typeof CustomTool>
/** 草稿：Agent 写的、用户在编辑页填的，版本和历史由面板管 */
export type ToolDraft = z.input<typeof CustomTool>

export const ToolScope = z.enum(['project', 'global'])
export type ToolScope = z.infer<typeof ToolScope>

/** 列表里的一项：工具 + 它在哪 + 读不进来时的原因（不悄悄跳过） */
export const ToolEntry = z.object({
  scope: ToolScope,
  file: z.string(),
  tool: CustomTool.optional(),
  /** 文件读不进来、格式不对：原样显示 */
  error: z.string().optional(),
  /** 全局的被项目里同 id 的盖住了 */
  shadowed: z.boolean().optional(),
  /** 最近一次运行 */
  last: z.object({ at: z.string(), ok: z.boolean(), ms: z.number(), summary: z.string().default('') }).optional(),
})
export type ToolEntry = z.infer<typeof ToolEntry>

/** 版本记录最多留几个 */
export const HISTORY_KEEP = 5

/** 存一版：版本号 +1，旧的这版进历史（最多留 HISTORY_KEEP 个）。服务端和演示后端共用 */
export function nextVersion(
  tool: CustomTool,
  prev: CustomTool | undefined,
  o: { by?: string; note?: string; now: string },
): CustomTool {
  return {
    ...tool,
    version: prev ? prev.version + 1 : 1,
    note: o.note ?? '',
    history: prev
      ? [
          {
            version: prev.version,
            at: prev.updatedAt || o.now,
            by: prev.createdBy,
            command: prev.run.command,
            note: prev.note,
          },
          ...prev.history,
        ].slice(0, HISTORY_KEEP)
      : [],
    createdBy: o.by || tool.createdBy || '',
    updatedAt: o.now,
  }
}
/** 「auto」在工具里等的上限：限时更长的交给后台命令 */
export const INLINE_MAX_SEC = 120
