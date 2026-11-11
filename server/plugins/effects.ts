import path from 'node:path'
import type { EvidenceCommand, TurnExtra } from '../../shared/done-evidence.ts'
import type { McpResult, McpTool } from './sdk.ts'

/**
 * 插件工具对项目做了什么（插件接口 3，McpTool.effect）：MCP 调用在解析层一律记成「其他」，
 * 面板的完成依据、验证门禁、改动归属都看不见插件写入了哪些资产、编译过没有。
 * 插件 MCP 会话（mcp.ts）在调用完成时按声明记一笔，end_turn 时按这一轮的输入时刻取出来（server/exec/turn-extra.ts）。
 *
 * 只记在内存里：面板重启后进行中那一轮的插件改动不再补进完成依据（工具调用记录本身还在对话里）
 */
export interface PluginEffect {
  kind: 'edit' | 'verify'
  /** 服务名 · 工具名 */
  tool: string
  /** 改了的文件 / 验证覆盖的文件（相对对话工作目录、正斜杠）；验证没写覆盖哪些时为空，表示覆盖这一轮插件改过的全部 */
  files: string[]
  /** verify：通过没有 */
  passed?: boolean
  /** verify：验证的名字（卡片上显示），没写时用工具名 */
  name?: string
  at: string
}

const MAX = 200
const effects = new Map<string, PluginEffect[]>()

/** 本机路径转成相对工作目录的写法；工作目录外的保留绝对路径（正斜杠） */
export function relTo(cwd: string, f: string) {
  const abs = path.resolve(cwd, f.trim())
  const r = path.relative(path.resolve(cwd), abs)
  return (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : abs).replace(/\\/g, '/')
}

/**
 * 一次插件工具调用结束：按工具的声明记下改了什么、验证得怎么样。返回改了的文件（本机绝对路径），
 * 交给 runner 记成这一轮的改动（和 CLI 自己的改文件工具同一条路，见 file-events.ts）
 */
export function notePluginEffect(
  taskId: string,
  cwd: string,
  server: string,
  tool: Pick<McpTool, 'name' | 'effect'>,
  r: Pick<McpResult, 'isError' | 'changed' | 'verified'>,
  at = new Date().toISOString(),
): string[] {
  const name = `${server} · ${tool.name}`
  let e: PluginEffect | undefined
  if (tool.effect === 'edit' && !r.isError && r.changed?.length) {
    e = {
      kind: 'edit',
      tool: name,
      files: r.changed.filter((f) => typeof f === 'string' && f.trim()).map((f) => relTo(cwd, f)),
      at,
    }
  } else if (tool.effect === 'verify' && (r.verified || r.isError)) {
    const v = r.verified
    e = {
      kind: 'verify',
      tool: name,
      files: (v?.files ?? []).filter((f) => typeof f === 'string' && f.trim()).map((f) => relTo(cwd, f)),
      // 工具本身报错按没通过算：插件没写 verified 时也不能当成验证过
      passed: !r.isError && !!v?.passed,
      ...(v?.name?.trim() && { name: v.name.trim().slice(0, 80) }),
      at,
    }
  }
  if (!e || (e.kind === 'edit' && !e.files.length)) return []
  const list = effects.get(taskId) ?? []
  list.push(e)
  effects.set(taskId, list.slice(-MAX))
  return e.kind === 'edit' ? e.files.map((f) => path.resolve(cwd, f)) : []
}

/**
 * since 之后（这一轮的输入时刻）插件的改动和验证，整理成完成依据的补充材料：
 * - 改了的文件进 files；
 * - 每次验证进 commands（plugin 标记），通过的把它覆盖的文件记成 covered，之后又被插件改过的再拿掉
 */
export function pluginExtra(taskId: string, since: string): TurnExtra {
  const list = (effects.get(taskId) ?? []).filter((e) => e.at >= since)
  const files: string[] = []
  const commands: EvidenceCommand[] = []
  const covered = new Set<string>()
  for (const e of list) {
    if (e.kind === 'edit') {
      for (const f of e.files) {
        if (!files.includes(f)) files.push(f)
        covered.delete(f)
      }
      continue
    }
    const command = e.name ?? e.tool
    commands.push({ command, plugin: true, ...(!e.passed && { failed: true }) })
    const scope = e.files.length ? e.files : files
    for (const f of scope) {
      if (e.passed) covered.add(f)
      else covered.delete(f)
    }
  }
  return { files, commands, covered: [...covered] }
}

/** 测试用：清掉记录 */
export function clearPluginEffects(taskId?: string) {
  if (taskId) effects.delete(taskId)
  else effects.clear()
}
