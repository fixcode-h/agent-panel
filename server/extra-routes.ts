/**
 * 自成一组的子路由：本机生图（ComfyUI）、语音输入、语音朗读、Chat 的「关于我」和记忆、面板外的通知渠道、「我不在」。
 * 从 server/index.ts 拆出（index.ts 到了行数上限），挂载的路径和以前一样
 */
import type { Hono } from 'hono'
import { comfyApi } from './comfy.ts'
import { speechApi } from './speech.ts'
import { ttsApi } from './tts.ts'
import { chatMemoryApi } from './chat-memory.ts'
import { notifyChannelsApi } from './notify-channels.ts'
import { awayApi, loadAway } from './away.ts'

// oxlint-disable-next-line typescript/no-explicit-any -- 主应用的 Hono 带着各自的环境类型，这里只挂子路由
export function mountExtras(
  app: Hono<any>,
  deps: { projects: { get: (id: string) => Promise<{ name: string } | null> } },
) {
  app.route('/local-image', comfyApi())
  app.route('/speech', speechApi())
  app.route('/tts', ttsApi())
  app.route('/chat-memory', chatMemoryApi())
  // 通知里要写项目名：项目按 id 现取，不缓存（改了名下一条通知就是新名字）
  app.route('/notify-channels', notifyChannelsApi(deps))
  // 「我不在」开关和自动选过的记录（server/away.ts）：启动时先读进内存，执行时同步查
  app.route('/away', awayApi())
  void loadAway()
}
