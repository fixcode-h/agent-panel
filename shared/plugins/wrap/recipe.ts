import { z } from 'zod'
import { McpServer } from '../../library.ts'
import { PluginService, PluginWebPage, reservedEnv } from '../runtime-schema.ts'
import { PluginSetting } from '../types.ts'

/**
 * 包装配方（ADR 0068，设计稿「GitHub项目一键变插件与网页页签」第 3、4、10 节）：把一个没有 plugin.json 的开源仓库
 * 变成标准插件包的声明式说明。识别器自动生成、社区写在插件仓库 wraps/<owner>__<repo>.json、「AI 帮我包装」产出的
 * 都是这同一种格式。配方只是数据：能做的事只有下面列出的几种，不能写脚本。
 */

/** 插件 id 的写法（和 PluginManifest.id 一致） */
const PluginId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
/** 配方里的相对路径：不许绝对路径和 .. （生成器还会再查一次） */
const RelPath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((p) => !/^[\\/]|^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).includes('..'), '路径不能是绝对路径或带 ..')
/** 仓库根本身（复制整个仓库时用） */
const RelOrRoot = z.union([z.literal('.'), RelPath])

/** 识别出来的内容是哪一种（预览里一行一种） */
/** 和清单 wrap.kinds 同一套名字（shared/plugins/runtime-schema.ts） */
export const WrapKind = z.enum(['skills', 'claude-plugin', 'mcp', 'cli', 'web-app'])
export type WrapKind = z.infer<typeof WrapKind>

/**
 * 安装动作白名单（设计稿 7.2 第 3 条）：确认后只在插件目录里做。
 * - npm-ci：`npm ci --ignore-scripts`，依赖装进包里的那个目录，不跑上游的安装钩子
 * - npm-package：把 npm 上发布的包（固定版本）装进包里的 cli/，同样 --ignore-scripts
 * - uv-tool：`uv tool install <包>==<版本>`，装进包里的 .tools
 * - release-asset：下载 Release 附件并核对 sha256（预览时从 GitHub 读到的摘要）
 * - npm-run：跑上游 package.json 里的构建脚本。会运行上游代码，预览里单列一条高级提示，要勾「我看过了」
 */
export const WrapAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npm-ci'), dir: RelOrRoot }),
  z.object({
    kind: z.literal('npm-package'),
    package: z.string().regex(/^(?:@[\w.-]+\/)?[\w.-]{1,100}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+[\w.+-]*$/),
  }),
  z.object({
    kind: z.literal('uv-tool'),
    package: z.string().regex(/^[A-Za-z0-9][\w.-]{0,99}$/),
    version: z.string().regex(/^[\w.+-]{1,40}$/),
  }),
  z.object({
    kind: z.literal('release-asset'),
    tag: z.string().min(1).max(100),
    asset: z.string().min(1).max(200),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** 放到包里的哪个目录 */
    to: RelPath.default('bin'),
  }),
  z.object({
    kind: z.literal('npm-run'),
    dir: RelOrRoot,
    script: z.string().regex(/^[\w:.-]{1,60}$/),
  }),
])
export type WrapAction = z.infer<typeof WrapAction>

/** 外部 MCP 服务：和清单 mcp 字段同形（MCP 库的条目） */
export const WrapMcp = McpServer
export type WrapMcp = z.infer<typeof WrapMcp>

export const WrapRecipe = z.object({
  /** owner/repo */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  id: PluginId,
  name: z.string().trim().min(1).max(60),
  icon: z.string().max(40).default('package'),
  description: z.string().max(500).default(''),
  /** 查更新跟什么：最新 Release（默认）、最新标签、分支（只建议自己的仓库用） */
  track: z.enum(['release', 'tag', 'branch']).default('release'),
  /** 不写由生成器按内容定（带 MCP / 进程 / PATH 的按项目，只有技能和环境变量的全局） */
  activation: z.enum(['global', 'project']).optional(),
  /** 技能：仓库里 SKILL.md 所在目录 → 包里 skills/<分类>/<名字>/ */
  skills: z
    .array(
      z.object({
        from: RelOrRoot,
        category: z
          .string()
          .regex(/^[\w-]{1,40}$/)
          .default('wrapped'),
        name: z.string().regex(/^[\w.-]{1,60}$/),
      }),
    )
    .max(50)
    .default([]),
  /** Claude Code 插件的命令 md → 「/」命令 */
  commands: z
    .array(z.object({ from: RelPath, name: z.string().regex(/^[A-Za-z0-9][\w:.-]{0,59}$/) }))
    .max(50)
    .default([]),
  /** Claude Code 插件的 agents/*.md → 角色 */
  agents: z
    .array(z.object({ from: RelPath, name: z.string().min(1).max(60) }))
    .max(20)
    .default([]),
  /** 原样复制进包的路径（命令行工具的源码、网页应用） */
  copy: z.array(RelOrRoot).max(50).default([]),
  /** 不进包的文件（glob，相对仓库根），比如示例目录 */
  exclude: z.array(z.string().max(200)).max(50).default([]),
  install: z.array(WrapAction).max(10).default([]),
  mcp: z.array(WrapMcp).max(10).default([]),
  settings: z.array(PluginSetting).max(20).default([]),
  /** 给 Agent 的环境变量：值可以写 {config.<参数>} */
  env: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/)
        .refine((k) => k.toUpperCase() !== 'PATH' && !reservedEnv(k), {
          error: (i) => reservedEnv(String(i.input)) || 'PATH 写在 path 字段里',
        }),
      z.string().max(1000),
    )
    .default({}),
  /** 前置到 PATH 的目录（相对包根） */
  path: z.array(RelPath).max(10).default([]),
  /** 托管进程、声明式网页页面：原样写进清单（插件接口 11） */
  services: z.array(PluginService).max(5).default([]),
  webPages: z.array(PluginWebPage).max(10).default([]),
})
export type WrapRecipe = z.infer<typeof WrapRecipe>
export type WrapRecipeInput = z.input<typeof WrapRecipe>

/** 识别器认出的一项：预览里一行，能勾选；skip 有值时默认不勾并写明原因 */
export const WrapCandidate = z.object({
  key: z.string(),
  kind: WrapKind,
  path: z.string(),
  /** 0–1，预览按它排序、默认勾高的 */
  confidence: z.number(),
  /** 一句话说明认出了什么、会怎么接 */
  reason: z.string(),
  /** 一个小标签：跟技能一起、发布的包…… */
  tag: z.string().optional(),
  skip: z.string().optional(),
})
export type WrapCandidate = z.infer<typeof WrapCandidate>

/** 「装上后会做什么」的一行 */
export const WrapStep = z.object({
  icon: z.enum(['copy', 'env', 'path', 'mcp', 'install', 'run', 'web', 'service']),
  text: z.string(),
  /** 会运行上游代码（npm-run）：要勾「我看过了」 */
  advanced: z.boolean().optional(),
})
export type WrapStep = z.infer<typeof WrapStep>

/** 配方从哪来：插件市场的社区配方 > 识别器 > AI */
export const WrapOrigin = z.enum(['recipe', 'detect', 'ai'])
export type WrapOrigin = z.infer<typeof WrapOrigin>

/** 配方的文件名：wraps/<owner>__<repo>.json */
export const recipeFile = (repo: string) => `wraps/${repo.replace('/', '__')}.json`
