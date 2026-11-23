/**
 * 自成一组的子路由：本机生图（ComfyUI）、语音输入、语音朗读、Chat 的「关于我」和记忆、面板外的通知渠道、「我不在」、小工具。
 * 从 server/index.ts 拆出（index.ts 到了行数上限），挂载的路径和以前一样；按 ApiModule 清单交给 server/routes/modules.ts
 */
import { comfyApi } from '../comfy.ts'
import { speechApi } from '../speech.ts'
import { ttsApi } from '../tts.ts'
import { chatMemoryApi } from '../chat-memory.ts'
import { notifyChannelsApi } from '../notify-channels.ts'
import { awayApi, loadAway } from '../away.ts'
import { ghDownloadApi } from '../tools/gh-download.ts'
import { fileIndexApi } from '../file-index/api.ts'
import { memoApi } from '../memo/api.ts'
import { bgJobsApi } from '../jobs/api.ts'
import type { ApiModule } from './module.ts'

export function extraModules(deps: {
  projects: {
    get: (id: string) => Promise<{ name: string } | null>
    list: () => Promise<{ id: string; name: string }[]>
  }
}): ApiModule[] {
  const list: ApiModule[] = [
    { prefix: '/local-image', app: comfyApi() },
    { prefix: '/speech', app: speechApi() },
    { prefix: '/tts', app: ttsApi() },
    { prefix: '/chat-memory', app: chatMemoryApi() },
    // 通知里要写项目名：项目按 id 现取，不缓存（改了名下一条通知就是新名字）
    { prefix: '/notify-channels', app: notifyChannelsApi(deps) },
    { prefix: '/away', app: awayApi() },
    // 「小工具」页：契约里的路径已经带着 /tools/<工具>
    { prefix: '/', app: ghDownloadApi() },
    // 项目文件索引：数据页（/file-index）和项目设置的状态卡（/projects/:id/file-index）
    {
      prefix: '/',
      app: fileIndexApi({
        projectNames: async () => new Map((await deps.projects.list()).map((p) => [p.id, p.name])),
      }),
    },
    // 派生缓存：数据页的「缓存」一节（/memo）
    { prefix: '/', app: memoApi() },
    // 后台作业：侧栏底部的作业列表（/bg-jobs）
    { prefix: '/', app: bgJobsApi() },
  ]
  // 「我不在」开关和自动选过的记录（server/away.ts）：启动时先读进内存，执行时同步查
  void loadAway()
  return list
}
