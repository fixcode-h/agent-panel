import { z } from 'zod'
import type { DesignMeta, DesignProject } from '../../shared/design.ts'
import { DESIGN_KINDS } from '../../shared/design.ts'
import { defineAction } from './registry.ts'
import { pushUi } from './ui.ts'

/**
 * UI 设计这一组：设计项目、设计（一个界面）、让设计里的 AI 改界面。
 * 「建一个 UI 对话，生成背包页面」= design.create（open: true）+ design.chat
 */

const enc = encodeURIComponent

export const designActions = [
  defineAction({
    name: 'design.projects',
    title: '列出设计项目',
    description: 'UI 设计的项目（和代码项目不是一套）：id、名字。新建设计要先选一个设计项目。',
    level: 'read',
    input: z.object({}),
    run: async (_a, ctx) =>
      ((await ctx.api('GET', '/designs/projects')) as DesignProject[]).map((p) => ({ id: p.id, name: p.name })),
  }),
  defineAction({
    name: 'design.list',
    title: '列出设计',
    description: '列出设计（一个设计就是一个界面），可按设计项目过滤；running 表示设计里的 AI 正在改。',
    level: 'read',
    input: z.object({ projectId: z.string().optional().describe('设计项目 id') }),
    run: async (a, ctx) =>
      ((await ctx.api('GET', `/designs${a.projectId ? `?projectId=${enc(a.projectId)}` : ''}`)) as DesignMeta[]).map(
        (d) => ({ id: d.id, title: d.title, projectId: d.projectId, kind: d.kind, running: !!d.running }),
      ),
  }),
  defineAction({
    name: 'design.create',
    title: '新建 UI 设计',
    description: '在设计项目里新建一个空白设计（一个界面）。open 为 true 时页面直接进入 UI 设计模式打开它。',
    level: 'write',
    input: z.object({
      projectId: z.string().trim().min(1).describe('设计项目 id，见 design.projects'),
      title: z.string().trim().min(1).max(100),
      kind: z.enum(DESIGN_KINDS).optional().describe('不写是 game（游戏界面）'),
      width: z.number().int().min(100).max(8192).optional(),
      height: z.number().int().min(100).max(8192).optional(),
      open: z.boolean().default(true),
    }),
    run: async (a, ctx) => {
      const d = (await ctx.api('POST', '/designs', {
        projectId: a.projectId,
        title: a.title,
        ...(a.kind ? { kind: a.kind } : {}),
        ...(a.width && a.height ? { designSize: { X: a.width, Y: a.height } } : {}),
      })) as DesignMeta
      // 打开失败（没有页面开着）不影响设计已经建好
      const opened = a.open ? ctx.ui('navigate', { page: 'design', id: d.id }) > 0 : false
      return { id: d.id, title: d.title, opened }
    },
  }),
  defineAction({
    name: 'design.open',
    title: '打开设计',
    description: '页面进入 UI 设计模式并打开这个设计；不写 id 只切到 UI 设计页。',
    level: 'write',
    input: z.object({ id: z.string().optional() }),
    run: async (a, ctx) => pushUi(ctx, 'navigate', { page: 'design', ...(a.id ? { id: a.id } : {}) }),
  }),
  defineAction({
    name: 'design.chat',
    title: '让设计 AI 改界面',
    description:
      '给设计里的 AI 发一条要求（例如「生成一个背包页面：左边分类页签，中间 5x6 格子，右边物品详情」），它在后台开始改这个设计，进度在页面上看。图片默认用设置里的生图 CLI 生成。',
    level: 'write',
    input: z.object({
      id: z.string().trim().min(1).describe('设计 id'),
      text: z.string().trim().min(1).max(20000),
      images: z.boolean().default(true).describe('false 时只搭控件不生成图片'),
    }),
    run: async (a, ctx) => {
      await ctx.api('POST', `/designs/${enc(a.id)}/chat`, {
        text: a.text,
        source: a.images ? { kind: 'cli' } : { kind: 'none' },
      })
      return { id: a.id, started: true }
    },
  }),
]
