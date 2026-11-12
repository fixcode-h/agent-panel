/**
 * create_conversation 的「先建模块文档」两个参数（ADR 0048，判定在 shared/docs-first.ts）。
 * 单独放一个文件：orch-mcp.ts 到了行数上限
 */
export const docsFirstFields = {
  modules: {
    type: 'array',
    items: { type: 'string' },
    description:
      '这次涉及的模块（模块地图里的模块名；还没写文档的写目录名）：还没有模块文档的面板会先拦下，让你派「文档」分析完再建；都有文档时把文档路径附进派单',
  },
  skip_docs: {
    type: 'string',
    description: '不先建模块文档的理由（模块分析失败、一次性的小改动）：写了就放行',
  },
} as const

/** 从工具参数里取这两个字段 */
export const docsFirstArgs = (a: Record<string, unknown> | undefined) => ({
  modules: Array.isArray(a?.modules) ? a.modules.map(String).filter(Boolean) : undefined,
  skipDocs: typeof a?.skip_docs === 'string' ? a.skip_docs : undefined,
})
