/**
 * 契约探查：按 catalog / tasks 契约把接口走一遍，逐个用 contractProblems 查返回形状。
 * 正式后端在 scripts/e2e/17-contracts.mjs 里跑，演示后端在 web/src/lib/demo-contract.test.ts 里跑，
 * 两边跑的是同一份流程：哪边少了字段、多了一层包装，报错里直接写出是哪个接口。
 *
 * 只给测试用，正式代码不要引入。会建一个分类、一个标签、一个角色副本，走完都删掉。
 */
import { catalogContract as C } from './catalog.ts'
import { contractProblems, urlOf, type Endpoint, type Query } from './define.ts'
import { tasksContract as T } from './tasks.ts'

/** 发一个请求、拿回解析好的 JSON（204 时是 undefined）；失败直接抛 */
export type ProbeFetch = (method: string, url: string, body?: unknown) => Promise<unknown>

export interface ProbeReport {
  /** 走过的接口（方法 + 契约路径） */
  checked: string[]
  /** 对不上的：「GET /agents：缺字段 [0].xxx」 */
  problems: string[]
}

export async function probeContracts(send: ProbeFetch): Promise<ProbeReport> {
  const checked: string[] = []
  const problems: string[] = []
  const hit = async <E extends Endpoint>(
    ep: E,
    opts: { params?: Record<string, string>; query?: Query; body?: unknown } = {},
  ) => {
    const name = `${ep.method} ${ep.path}`
    const res = await send(ep.method, urlOf(ep.path, opts.params, opts.query), opts.body)
    if (!checked.includes(name)) checked.push(name)
    for (const p of contractProblems(ep.res, res)) problems.push(`${name}：${p}`)
    return res as never
  }

  // 设置：读一份、原样存回去
  const settings = await hit(C.settings)
  await hit(C.saveSettings, { body: settings })

  // 分类、标签：建一个、改一下、删掉
  const cat = (await hit(C.createCategory, { body: { name: '契约探查分类', scope: 'agent' } })) as { id: string }
  await hit(C.renameCategory, { params: { id: cat.id }, body: { name: '契约探查分类2' } })
  await hit(C.categories)
  await hit(C.deleteCategory, { params: { id: cat.id } })

  const tag = (await hit(C.createTag, { body: { name: '契约探查标签', color: 'blue' } })) as { id: string }
  await hit(C.updateTag, { params: { id: tag.id }, body: { name: '契约探查标签2', color: 'teal' } })
  await hit(C.tags)
  await hit(C.deleteTag, { params: { id: tag.id } })

  // 角色：拿第一个复制一份（复制出来的是普通角色），改个名，再删掉
  const agents = (await hit(C.agents)) as { id: string; name: string; origin?: string }[]
  if (agents[0]) {
    const copy = (await hit(C.createAgent, {
      body: { ...agents[0], id: undefined, name: '契约探查角色', origin: '' },
    })) as Record<string, unknown> & { id: string }
    await hit(C.updateAgent, { params: { id: copy.id }, body: { ...copy, name: '契约探查角色2' } })
    await hit(C.deleteAgent, { params: { id: copy.id } })
  }

  await hit(C.workflows)
  await hit(C.projectCategories)
  await hit(C.schedules)
  const projects = (await hit(C.projects)) as { id: string }[]

  // 任务：每个项目的列表；找一个有子对话的父对话测详情和子对话栏
  let parent = ''
  for (const p of projects) {
    const list = (await hit(T.list, { query: { projectId: p.id } })) as { id: string; childrenWorking?: number }[]
    for (const t of list) {
      if (parent) break
      const kids = (await hit(T.children, { params: { id: t.id } })) as unknown[]
      if (kids.length) parent = t.id
    }
  }
  if (parent) await hit(T.page, { params: { id: parent }, query: { limit: 40 } })

  return { checked, problems }
}
