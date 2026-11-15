#!/usr/bin/env node
/**
 * 教训、经验推送的回放评测（设计稿「经验与教训重新设计」6.4，一期 ①）：只读，不改数据目录里的任何东西。
 * 读数据目录里已有对话的工具调用，按时间顺序重放面板钩子的推送规则（shared/knowledge/push.ts），输出：
 * 会推多少次、推了哪些、每个对话多花多少字、匹配耗时，以及失败后换做法才成、报错复发、搜了多久才动手这些根因的真实数字。
 * 规则在 shared/knowledge/replay.ts，和面板钩子是同一份。
 *
 * 用法：
 *   node scripts/knowledge-replay.mjs                    # 默认数据目录（AGENT_PANEL_DATA 或 ~/.agent-panel）
 *   node scripts/knowledge-replay.mjs --data <目录>      # 指定数据目录
 *   node scripts/knowledge-replay.mjs --project <名字或 id>  # 只看一个项目
 *   node scripts/knowledge-replay.mjs --json             # 输出 JSON（贴给 Agent 分析用）
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { tsImport } from 'tsx/esm/api'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dataDir = path.resolve(opt('--data') ?? process.env.AGENT_PANEL_DATA ?? path.join(homedir(), '.agent-panel'))
const only = opt('--project')
const asJson = args.includes('--json')
if (!existsSync(dataDir)) {
  console.error(`数据目录不存在：${dataDir}（用 --data 指定）`)
  process.exit(1)
}
// 服务端模块按 AGENT_PANEL_DATA 定数据目录：要在加载之前设好
process.env.AGENT_PANEL_DATA = dataDir

const { Project, Agent } = await tsImport('../shared/schema.ts', import.meta.url)
const { replay } = await tsImport('../shared/knowledge/replay.ts', import.meta.url)
const { lessonsPrompt } = await tsImport('../shared/lessons.ts', import.meta.url)
const { experiencePrompt } = await tsImport('../shared/experience.ts', import.meta.url)
const { parseMessagesJsonl } = await tsImport('../server/tasks/messages-file.ts', import.meta.url)
const { loadProjectLessons } = await tsImport('../server/projects/lessons.ts', import.meta.url)
const { loadProjectExperience } = await tsImport('../server/projects/experience.ts', import.meta.url)

const readJson = async (f) => JSON.parse(await readFile(f, 'utf8').catch(() => 'null'))
const listOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : [])
const projects = listOf(await readJson(path.join(dataDir, 'projects', 'projects.json')))
  .map((p) => Project.safeParse(p))
  .filter((r) => r.success)
  .map((r) => r.data)
const agents = listOf(await readJson(path.join(dataDir, 'config', 'agents.json')))
  .map((a) => Agent.safeParse(a))
  .filter((r) => r.success)
  .map((r) => r.data)

/** 一个项目的全部对话（含子对话）：任务文件 + 消息 JSONL，只取 Agent 的工具调用 */
async function conversations(projectId) {
  const dir = path.join(dataDir, 'tasks', 'projects', projectId)
  const names = await readdir(dir).catch(() => [])
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json') || n.endsWith('.messages.json')) continue
    const meta = await readJson(path.join(dir, n))
    if (!meta?.id) continue
    const text = await readFile(path.join(dir, `${meta.id}.messages.jsonl`), 'utf8').catch(() => '')
    const msgs = text ? parseMessagesJsonl(text).messages : (meta.messages ?? [])
    const tools = msgs.filter((m) => m.role === 'agent').flatMap((m) => m.tools ?? [])
    if (tools.length) out.push({ id: meta.id, title: meta.title ?? '', at: meta.createdAt ?? '', tools })
  }
  return out
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-')
const results = []
for (const p of projects) {
  if (only && p.id !== only && p.name !== only) continue
  const convs = await conversations(p.id)
  if (!convs.length) continue
  const lessons = (await loadProjectLessons(p, agents).catch(() => ({ lessons: [] }))).lessons
  const exps = p.path ? (await loadProjectExperience(p, agents).catch(() => ({ items: [] }))).items : []
  const stats = replay(convs, lessons, exps, [p.path].filter(Boolean))
  // 开头那一段现在有多长（新规则）：按「有面板工具、能记」算，需求原文取最近一个对话的标题
  const prompt = {
    lessons: lessonsPrompt(lessons, true, [], true).length,
    experience: experiencePrompt(exps, convs.at(-1)?.title ?? '', true, true).length,
  }
  results.push({
    project: p.name,
    id: p.id,
    lessons: lessons.filter((l) => l.enabled).length,
    experience: exps.filter((e) => e.enabled).length,
    prompt,
    ...stats,
  })
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2))
  process.exit(0)
}
if (!results.length) {
  console.log(`没有找到带工具调用的对话（数据目录：${dataDir}）`)
  process.exit(0)
}
for (const r of results) {
  const pushes = Object.values(r.pushes).reduce((a, b) => a + b, 0)
  console.log(`\n## ${r.project}（${r.id}）：${r.conversations} 个对话，教训 ${r.lessons} 条，经验 ${r.experience} 条`)
  console.log(
    `工具调用：命令 ${r.tools.run}、改文件 ${r.tools.edit}、读文件 ${r.tools.read}、搜索 ${r.tools.search}；失败 ${r.failures}`,
  )
  console.log(
    `会推送 ${pushes} 次：跑命令前 ${r.pushes.command}、改文件前 ${r.pushes.path}、搜索前 ${r.pushes.search}、报错后 ${r.pushes.error}`,
  )
  console.log(
    `推送字数：合计 ${r.pushChars}，有推送的对话 ${r.convWithPush}（${pct(r.convWithPush, r.conversations)}），平均每个对话 ${Math.round(r.pushChars / r.conversations)}，最多 ${r.maxConvChars}`,
  )
  console.log(`开头一段（新规则）：教训 ${r.prompt.lessons} 字，经验 ${r.prompt.experience} 字`)
  console.log(`匹配耗时 p95：${r.matchP95} ms / 次`)
  console.log(
    `根因的真实数字：失败后换了做法才成 ${r.fixAfterFail} 次；报错在之后的对话里复发 ${r.recurCovered + r.recurUncovered} 种（已有教训覆盖 ${r.recurCovered}，没覆盖 ${r.recurUncovered}）；第一次改文件前搜 / 读步数中位数 ${r.detourMedian}，≥8 步的对话 ${r.detourOver8}`,
  )
  if (r.topHits.length) {
    console.log('推得最多的条目（按对话数）：')
    for (const h of r.topHits) console.log(`  ${h.kind === 'lesson' ? '教训' : '经验'} ${h.id} ×${h.convs}  ${h.title}`)
  }
  if (r.topRecur.length) {
    console.log('复发了却没有教训覆盖的报错（按对话数）：')
    for (const x of r.topRecur) console.log(`  ×${x.convs}  ${x.sample}`)
  }
}
