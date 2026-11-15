/**
 * 契约探查：按 catalog / tasks 契约把接口走一遍，逐个用 contractProblems 查返回形状。
 * 正式后端在 scripts/e2e/17-contracts.mjs 里跑，演示后端在 web/src/lib/demo/demo-contract.test.ts 里跑，
 * 两边跑的是同一份流程：哪边少了字段、多了一层包装，报错里直接写出是哪个接口。
 *
 * 只给测试用，正式代码不要引入。会建一个分类、一个标签、一个角色副本，走完都删掉；
 * 给第一个项目记一条教训，删一个对话再从回收站恢复；建一个风格再删掉；工作总结的项目配置原样存回去。
 * 钩子只读列表、最近触发和校验，不建钩子（建了会在真机的对话里触发）。
 */
import { catalogContract as C } from './catalog.ts'
import { contractProblems, urlOf, type Endpoint, type Query } from './define.ts'
import { projectsContract as P } from './projects.ts'
import { tasksContract as T } from './tasks.ts'
import { trashContract as R } from './trash.ts'
import { mcpCatalogContract as M } from './mcp-catalog.ts'
import { hooksContract as H } from './hooks.ts'
import { browserExtContract as B, stylesContract as S } from './styles.ts'
import { lessonDraftsContract as L, summaryContract as W } from './summary.ts'

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
    // 删掉的角色进了回收站（演示后端没有回收站，列表是空的）：恢复出来，再删掉并彻底清掉
    const items = (await hit(R.items)) as { kind: string; id: string }[]
    if (items.some((x) => x.kind === 'agent' && x.id === copy.id)) {
      await hit(R.restoreItem, { params: { kind: 'agent', id: copy.id }, body: {} })
      await hit(C.deleteAgent, { params: { id: copy.id } })
      await hit(R.purgeItem, { params: { kind: 'agent', id: copy.id } })
    }
  }

  await hit(C.workflows)
  await hit(C.projectCategories)
  await hit(C.schedules)
  const projects = (await hit(C.projects)) as (Record<string, unknown> & { id: string; updatedAt: string })[]

  // 项目设置：原样存回去（带读取时的版本）、记一条教训、问是不是面板源码；全局教训原样存回去
  if (projects[0]) {
    const p = projects[0]
    await hit(P.update, { params: { id: p.id }, body: { ...p, expectedUpdatedAt: p.updatedAt } })
    await hit(P.addLesson, { params: { id: p.id }, body: { title: '契约探查的教训' } })
    await hit(P.panelSource, { params: { id: p.id } })
    await hit(P.capabilityProbe, { body: { projectId: p.id, path: String(p.path ?? '') } })
  }
  const lessons = await hit(P.globalLessons)
  await hit(P.saveGlobalLessons, { body: { lessons, confirmed: true } })

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

  // 回收站：删一个顶层对话、列出来、再恢复
  const first = projects[0]
    ? ((await send('GET', urlOf(T.list.path, {}, { projectId: projects[0].id }))) as { id: string }[])[0]
    : undefined
  if (first) {
    await hit(R.deleteTask, { params: { id: first.id } })
    await hit(R.tasks)
    await hit(R.restoreTask, { params: { id: first.id }, body: {} })
  }

  // 设置 →「MCP」：能力目录、自检（只读）
  await hit(M.catalog)
  await hit(M.check, { body: { projectId: '', agentId: '', cli: 'claude', kind: 'parent' } })

  // 设置 →「钩子」：列表（全局、按项目）、最近触发、只查形状的校验
  await hit(H.list)
  if (projects[0]) await hit(H.list, { query: { projectId: projects[0].id } })
  await hit(H.triggers)
  await hit(H.check, { body: { def: { name: '契约探查', event: 'task.done', action: { type: 'http', url: '' } } } })

  // 风格库：建一个、改个名、删掉；浏览器扩展只读连接状态（装、刷新会打开浏览器和文件夹）
  await hit(S.list)
  const style = (await hit(S.create, { body: { name: '契约探查风格' } })) as { id: string }
  await hit(S.update, { params: { id: style.id }, body: { name: '契约探查风格2' } })
  await hit(S.remove, { params: { id: style.id } })
  await hit(B.status)

  // 工作总结：报告列表、项目配置原样存回去、候选教训草稿（提炼会跑 CLI，不探）
  await hit(W.list)
  const summaryConfig = await hit(W.config)
  await hit(W.saveConfig, { body: summaryConfig })
  await hit(L.list)

  return { checked, problems }
}
