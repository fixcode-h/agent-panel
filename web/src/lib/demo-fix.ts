import { FixInput, type FixJob } from '@shared/fix'

/** 在线演示的「AI 处理」：过几秒给一段示例的分析结果，不真的动本机 */
const jobs = new Map<string, FixJob>()

export function startDemoFix(body: unknown): FixJob {
  const input = FixInput.parse(body)
  const job: FixJob = {
    id: crypto.randomUUID(),
    title: input.title,
    topic: input.topic,
    cli: 'claude',
    status: 'running',
    text: '',
    startedAt: Date.now(),
  }
  jobs.set(job.id, job)
  setTimeout(() => (job.thinking = '先看看报错和输出，确认是哪一步出的问题。'), 600)
  setTimeout(() => (job.tools = ['Bash which pi', 'Bash npm ls -g --depth=0']), 1400)
  setTimeout(() => {
    if (job.status !== 'running') return
    job.status = 'done'
    job.text = `**原因**：${input.error ? input.error.split('\n')[0] : input.title}

**处理**：查了一下相关的路径和版本，按出错的步骤重新执行了一遍。

**现在**：已经正常了，回到页面点「重新检测」确认一下即可。（这是在线演示，结果是示例。）`
  }, 3000)
  return job
}

export const demoFixJob = (id: string) => jobs.get(id)
export function stopDemoFix(id: string) {
  const j = jobs.get(id)
  if (j && j.status === 'running') Object.assign(j, { status: 'failed', error: '已取消' })
  return j
}
