/**
 * 设置「网络与代理」的接口契约（ADR 0062 的写法）。检测本机代理那条早于契约，仍在 web/src/lib/api-net.ts 手写。
 */
import { z } from 'zod'
import { GithubSourceSetting } from '../github-sources/registry.ts'
import { endpoint } from './define.ts'

/** 「GitHub 下载来源」检测的一条结果：key 对应 resolveSources 展开后的 key */
export const GithubSourceTest = z.object({
  key: z.string(),
  ok: z.boolean(),
  ms: z.number().optional(),
  error: z.string().optional(),
  /** 这个来源不适用样例文件（不会出现在内置来源上，留给以后只管 Release 的来源） */
  skipped: z.boolean().optional(),
})
export type GithubSourceTest = z.infer<typeof GithubSourceTest>

export const netContract = {
  /** 按页面上当前的列表（还没自动保存也行）逐个来源取一次样例文件 */
  testGithubSources: endpoint({
    method: 'POST',
    path: '/net/github-sources/test',
    body: z.object({ sources: z.array(GithubSourceSetting) }),
    res: z.object({ results: z.array(GithubSourceTest) }),
  }),
}
