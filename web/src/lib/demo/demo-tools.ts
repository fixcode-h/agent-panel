/**
 * 演示：小工具「GitHub 加速下载」。演示版没有本机磁盘和出网，地址整理、来源挑选照样用 shared 里的同一份逻辑，
 * 下载本身不发生：点下载后马上记一条「已完成」的记录，大小是假的，看得到记录长什么样。
 */
import {
  downloadCandidates,
  normalizeGithubInput,
  pickCandidates,
  GhDownloadStart,
  type GhDownloadJob,
} from '@shared/tools/gh-download'
import type { GithubSourceSetting } from '@shared/github-sources/registry'
import { fail } from './demo-http'

const DIR = '/home/demo/Downloads'
const jobs: GhDownloadJob[] = [] // 演示的下载记录只在这一页里

export function demoTools(method: string, seg: string[], body: unknown, sources: GithubSourceSetting[]) {
  const [, tool, id, action] = seg
  if (tool !== 'gh-download') return fail('没有这个小工具', 404)
  if (method === 'GET') return { jobs, defaultDir: DIR, sources }
  if (method === 'POST' && !id) {
    const input = GhDownloadStart.parse(body)
    const norm = normalizeGithubInput(input.url)
    if ('error' in norm) return fail(norm.error)
    const tries = pickCandidates(downloadCandidates(norm.url, sources), input.source)
    if (!tries.length) return fail('没有可用的下载来源：选的来源不适用这个地址，或设置里的来源都关了')
    const size = 3_400_000 + Math.floor(Math.random() * 9_000_000)
    const job: GhDownloadJob = {
      id: crypto.randomUUID(),
      input: input.url,
      url: norm.url,
      name: norm.name,
      pick: input.source,
      status: 'done',
      source: tries[0].label,
      received: size,
      total: size,
      path: `${input.dir || DIR}/${norm.name}`,
      startedAt: Date.now(),
      endedAt: Date.now(),
    }
    jobs.unshift(job)
    return job
  }
  const i = jobs.findIndex((j) => j.id === id)
  if (i < 0) return fail('找不到这条下载记录', 404)
  if (method === 'DELETE') {
    jobs.splice(i, 1)
    return { ok: true }
  }
  if (action === 'reveal') return { ok: true }
  return jobs[i]
}
