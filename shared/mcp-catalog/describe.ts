/**
 * 交给 Agent 的工具说明从声明拼出来（设计稿第 5.1 节）：原 description 一个字不删，后面补「什么时候用」「不要用」两行。
 * 面板的 tools/list（server/ask-mcp.ts）、插件的 tools/list（server/plugins/mcp.ts）和设置页的目录都调这里，
 * 所以人看到的和 Agent 拿到的是同一份。
 */
import type { CatalogParam, ToolGuide } from './types.ts'

const USE = '什么时候用：'
const AVOID = '不要用：'

/** 原文已经写了这句就不重复（插件作者可能先把时机写进了 description） */
const has = (text: string, line: string) => text.replace(/\s+/g, '').includes(line.replace(/\s+/g, ''))

export function describeTool(description: string, guide?: Pick<ToolGuide, 'useWhen' | 'avoidWhen'>): string {
  if (!guide) return description
  const add: string[] = []
  if (guide.useWhen && !has(description, guide.useWhen)) add.push(USE + guide.useWhen)
  if (guide.avoidWhen && !has(description, guide.avoidWhen)) add.push(AVOID + guide.avoidWhen)
  return add.length ? `${description.trimEnd()}\n${add.join('\n')}` : description
}

/** more_tools 列表里一个收起来的工具的简介：有声明用「显示名：作用」，没有取说明的第一句 */
export function briefOf(t: { title?: string; description?: string }, guide?: Pick<ToolGuide, 'title' | 'summary'>) {
  if (guide) return `${guide.title}：${guide.summary}`
  return t.title ?? (t.description ?? '').split(/(?<=[。.！？])/)[0].slice(0, 80)
}

interface JsonSchemaProp {
  type?: string | string[]
  enum?: unknown[]
  items?: { type?: string }
  description?: string
}

/** 参数表：从 inputSchema 的 properties 生成，类型写成人能看懂的样子（enum 列出取值） */
export function paramsOf(schema: unknown): CatalogParam[] {
  const s = (schema ?? {}) as { properties?: Record<string, JsonSchemaProp>; required?: string[] }
  const req = new Set(s.required ?? [])
  return Object.entries(s.properties ?? {}).map(([name, p]) => ({
    name,
    type: p.enum?.length
      ? p.enum.map(String).join(' | ')
      : p.type === 'array' && p.items?.type
        ? `${p.items.type}[]`
        : [p.type ?? 'any'].flat().join(' | '),
    description: p.description ?? '',
    required: req.has(name),
  }))
}
