/**
 * 在线演示版的项目说明文件：没有本机磁盘，文件内容存在页面内存里；
 * 「AI 优化」不跑 CLI，过两秒给出一份补全过的示例。
 */
import {
  docFiles,
  DocOptimizeInput,
  DocWrite,
  type DocFile,
  type DocJob,
  type ProjectDoc,
  type ProjectDocs,
} from '@shared/docs'

const SAMPLE = `# 项目约定

React + Vite 的商城前端。

## 常用命令

- \`npm run dev\` 本地开发
- \`npm test\` 运行测试
`

const files = new Map<string, Map<DocFile, string>>()
const of = (projectId: string) => {
  let m = files.get(projectId)
  if (!m) files.set(projectId, (m = new Map([['AGENTS.md', SAMPLE]])))
  return m
}
const doc = (m: Map<DocFile, string>, path: DocFile): ProjectDoc => {
  const content = m.get(path)
  return content === undefined
    ? { path, exists: false, content: '', bytes: 0 }
    : { path, exists: true, content, bytes: new TextEncoder().encode(content).length }
}

export function demoDocs(projectId: string, dir: string): ProjectDocs {
  const m = of(projectId)
  return { dir, files: docFiles().map((f) => doc(m, f)) }
}

export function saveDemoDoc(projectId: string, body: unknown): ProjectDoc {
  const { path, content } = DocWrite.parse(body)
  of(projectId).set(path, content)
  return doc(of(projectId), path)
}

const jobs = new Map<string, DocJob>()

export function startDemoDocJob(body: unknown): DocJob {
  const input = DocOptimizeInput.parse(body)
  const job: DocJob = { id: crypto.randomUUID(), path: input.path, status: 'running', text: '', startedAt: Date.now() }
  jobs.set(job.id, job)
  const base = input.content.trim() || `# 项目约定\n\nReact + Vite 的商城前端。`
  setTimeout(() => (job.thinking = '先看看 package.json 和目录结构，核对说明里的命令。'), 600)
  setTimeout(() => (job.tools = ['package.json', 'src/', 'README.md']), 1200)
  setTimeout(() => {
    if (job.status !== 'running') return
    job.status = 'done'
    job.text = '核对了 package.json 里的命令，补上了目录结构和代码风格（这是在线演示，内容是示例）。'
    job.result = `${base.trimEnd()}

## 目录结构

- \`src/pages/\` 页面
- \`src/components/\` 通用组件
- \`src/store/\` 状态（购物车、用户）
- \`tests/\` 单元测试

## 代码风格

- TypeScript 严格模式，组件用函数式写法
- 改完运行 \`npm test\`，全部通过再提交
${input.request ? `\n## 补充\n\n- ${input.request}\n` : ''}`
  }, 2400)
  return job
}

export const demoDocJob = (id: string) => jobs.get(id)
export function stopDemoDocJob(id: string) {
  const j = jobs.get(id)
  if (j && j.status === 'running') Object.assign(j, { status: 'failed', error: '已停止' })
  return j
}

/** 设置「部署」里的全局说明：AI 生成 / 优化，过两秒给一份示例 */
export function startDemoGlobalDocJob(body: { content?: string; request?: string }): DocJob {
  const job: DocJob = { id: crypto.randomUUID(), path: 'AGENTS.md', status: 'running', text: '', startedAt: Date.now() }
  jobs.set(job.id, job)
  const base = body.content?.trim() || '# 全局约束\n\n## 语言\n始终用中文回答；代码、命令和报错原文保持原样。'
  setTimeout(() => (job.thinking = '只保留跨项目都成立的约束，去掉具体项目的命令。'), 600)
  setTimeout(() => {
    if (job.status !== 'running') return
    job.status = 'done'
    job.text = '整理了分节，补上了命令执行和安全边界（这是在线演示，内容是示例）。'
    job.result = `${base.trimEnd()}

## 安全边界

push、发布、破坏性清理都要用户明确授权；不覆盖用户已有的改动。
${body.request ? `\n## 补充\n\n- ${body.request}\n` : ''}`
  }, 2000)
  return job
}
