/**
 * 自成一组的子路由：本机生图（ComfyUI）、语音输入、语音朗读、Chat 的「关于我」和记忆。
 * 从 server/index.ts 拆出（index.ts 到了行数上限），挂载的路径和以前一样
 */
import type { Hono } from 'hono'
import { comfyApi } from './comfy.ts'
import { speechApi } from './speech.ts'
import { ttsApi } from './tts.ts'
import { chatMemoryApi } from './chat-memory.ts'

// oxlint-disable-next-line typescript/no-explicit-any -- 主应用的 Hono 带着各自的环境类型，这里只挂子路由
export function mountExtras(app: Hono<any>) {
  app.route('/local-image', comfyApi())
  app.route('/speech', speechApi())
  app.route('/tts', ttsApi())
  app.route('/chat-memory', chatMemoryApi())
}
