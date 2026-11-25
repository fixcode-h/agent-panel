/**
 * 自建工具（ADR 0082）的接口契约：管理页列出、保存、删除、复制到另一个范围、试运行。
 * Agent 那边走面板工具 custom_tool，不走这些接口
 */
import { z } from 'zod'
import { ToolEntry, ToolScope } from '../custom-tools/schema.ts'
import { endpoint } from './define.ts'

export const ToolList = z.object({
  entries: z.array(ToolEntry),
  /** 项目工具的目录（文档根/AgentPanel/Tools）；不在项目里时没有 */
  projectDir: z.string().optional(),
  globalDir: z.string(),
})
export type ToolList = z.infer<typeof ToolList>

export const ToolSaveBody = z.object({
  projectId: z.string().optional(),
  scope: ToolScope,
  /** 草稿：版本、历史由面板管，传什么都会被覆盖 */
  tool: z.looseObject({ id: z.string(), name: z.string() }),
  /** 同 id 已经有了：true 更新它（版本 +1），false 时报错 */
  replace: z.boolean().default(false),
  /** 这一版改了什么（版本记录里显示） */
  note: z.string().default(''),
  by: z.string().default(''),
})

export const ToolRunBody = z.object({
  projectId: z.string().optional(),
  /** 跑已保存的：scope + id；跑草稿：draft */
  scope: ToolScope.optional(),
  id: z.string().optional(),
  draft: z.looseObject({ id: z.string() }).optional(),
  args: z.record(z.string(), z.unknown()).default({}),
  /** 只展开命令，不执行 */
  dryRun: z.boolean().default(false),
})

export const ToolRunRes = z.object({
  ok: z.boolean(),
  /** 交给 Agent 的那份文字（试运行显示同一份） */
  text: z.string(),
  /** 展开后的命令 */
  line: z.string().default(''),
  /** 输出全文的尾部（最多 400 行），试运行页滚动显示 */
  output: z.array(z.string()).default([]),
})
export type ToolRunRes = z.infer<typeof ToolRunRes>

export const customToolsContract = {
  list: endpoint({ method: 'GET', path: '/custom-tools', res: ToolList }),
  save: endpoint({ method: 'PUT', path: '/custom-tools', body: ToolSaveBody, res: ToolEntry }),
  remove: endpoint({
    method: 'DELETE',
    path: '/custom-tools/:scope/:id',
    res: z.object({ ok: z.boolean(), info: z.string().default('') }),
  }),
  /** 复制到另一个范围（move 时删掉原来的） */
  copy: endpoint({
    method: 'POST',
    path: '/custom-tools/:scope/:id/copy',
    body: z.object({ projectId: z.string().optional(), to: ToolScope, move: z.boolean().default(false) }),
    res: ToolEntry,
  }),
  /** 试运行：和 Agent 调用同一套校验、守卫和签出（授权卡不弹：人自己点的） */
  run: endpoint({ method: 'POST', path: '/custom-tools/run', body: ToolRunBody, res: ToolRunRes }),
}
