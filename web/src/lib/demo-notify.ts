import { notifyUrlProblem, type NotifyChannel, type NotifyDelivery } from '@shared/notify-channels'

/**
 * 在线演示里的「通知渠道」：设置界面照常能加、能改（渠道跟着演示设置存在浏览器里），
 * 「发一条测试」不真的往外发请求——演示页是公开的，不能替访客往任意地址发东西——只按地址填得对不对给一个模拟结果，
 * 记进「最近一次」，让成功和失败两种样子都看得到
 */
const last: Record<string, NotifyDelivery> = {}

export const demoNotifyStatus = () => ({ ...last })

export function demoNotifyTest(channel: NotifyChannel) {
  const error = notifyUrlProblem(channel.url)
  last[channel.id] = { at: new Date().toISOString(), ok: !error, error, event: 'needs', test: true }
  return { ok: !error, error, status: demoNotifyStatus() }
}
