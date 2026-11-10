import type { Task } from '@shared/schema'
import { json, request } from './api'

/**
 * 「换个模型重试」（分析稿 A7）：把对话的模型改成选的那个，并把失败的那一轮原样重发。
 * 走的就是「重试 / 继续执行」那个接口（/tasks/:id/resume），多带一个 model：服务端在占住执行位之后改模型再重发，
 * 不会出现「模型改了、重发没发出去」的半截状态。单独一个文件：api.ts 到了行数上限。
 * 演示版没有后端：交给 demo-retry.ts（先改模型，再走演示后端自己的「继续」）
 */
export interface RetryModelPick {
  /** 对话现在实际用的 CLI：模型是它名下的 */
  cli: string
  model: string
  /** 新模型支持的思考强度：原来的强度它不支持时回到默认，不然 CLI 会直接报错 */
  efforts: string[]
}

export const retryWithModel = async (task: Pick<Task, 'id' | 'agentId' | 'effort'>, pick: RetryModelPick) =>
  import.meta.env.VITE_DEMO
    ? (await import('./demo-retry')).demoRetryWithModel(task, pick)
    : request<Task>(
        `/tasks/${task.id}/resume`,
        json('POST', { latest: false, model: pick.model, efforts: pick.efforts }),
      )
