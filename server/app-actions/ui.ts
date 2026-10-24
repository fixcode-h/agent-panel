import { z } from 'zod'
import { ActionError, defineAction, type ActionCtx } from './registry.ts'

/**
 * 界面这一组：切页面、打开设置。界面状态在页面里，服务端经 /api/app/events 推给打开着的页面，
 * 页面在 web/src/lib/ui-actions.ts 里找处理函数执行
 */

/** 推给页面；没有页面开着时说清楚，模型好转告用户 */
export function pushUi(ctx: ActionCtx, action: string, args: Record<string, unknown> = {}) {
  const n = ctx.ui(action, args)
  if (!n) throw new ActionError('面板页面没有打开，界面操作做不了：请用户先在浏览器里打开面板')
  return { pages: n }
}

/** 页面名和 web/src/lib/data.tsx 的 PageId 一致 */
export const PAGES = ['home', 'projects', 'chat', 'agents', 'workflows', 'design', 'comfy', 'library', 'mcp'] as const

export const uiActions = [
  defineAction({
    name: 'ui.navigate',
    title: '切到某一页',
    description:
      '让面板页面切到某一页：projects（id=项目 id，sub=对话 id）、chat、agents、workflows、design（UI 设计，id=设计 id）、comfy、library、mcp、home。',
    level: 'write',
    input: z.object({
      page: z.enum(PAGES),
      id: z.string().optional(),
      sub: z.string().optional(),
    }),
    run: async (a, ctx) => pushUi(ctx, 'navigate', a),
  }),
  defineAction({
    name: 'ui.open_settings',
    title: '打开设置',
    description:
      '在页面上打开设置窗口。section 可选：general、fonts、categories、tags、global-lessons、models、deploy、apis、assist、integrations、remote、local-image、styles、data、usage、update。',
    level: 'write',
    input: z.object({ section: z.string().optional().describe('打开哪一栏，不写是「常规」') }),
    run: async (a, ctx) => pushUi(ctx, 'open_settings', a),
  }),
]
