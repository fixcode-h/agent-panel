import { existsSync } from 'node:fs'
import { readdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { joinPath } from '../shared/doc-root.ts'
import { EXP_KEYWORDS_MAX, EXP_PATHS_MAX, ProjectExperience, sameExperience } from '../shared/experience.ts'
import { hash53 } from '../shared/hash.ts'
import { t } from '../shared/i18n.ts'
import type { Agent, Project } from '../shared/schema.ts'
import { enqueueWrite, projectDocBase, writeTextAtomic } from './project-lessons.ts'

/**
 * 项目经验存进项目文档根的 agent-knowledge/experience/，一条一个文件（设计稿 docs/openspec/changes/project-knowledge/design.md）：
 * 跟着项目走、能读能手改、能进版本管理；P4 / SVN 各分支共用一个文档根时各分支看到同一份（ADR 0052）。
 * 和教训一样一条一个文件：几个对话同时学到经验时各写各的，不会互相覆盖。
 */

export const KNOWLEDGE_DIR = 'agent-knowledge'
const EXP_DIR = 'experience'
const START = '<!-- experience -->'
const END = '<!-- /experience -->'
const README = 'README.md'
const README_TEXT = `# 项目经验

这个目录由 Agent 面板维护，一条经验一个文件：整个对话完成后面板自动学到的「做某类事最快的路」（在哪找、叫法对照、命令、验证方法），
也可以在项目设置的「经验」里手动加。Agent 需要时用 project_experience 按关键词查，不会整份塞进提示词。
可以直接改；某个文件格式不对时面板跳过它、不覆盖。
`

export async function projectExperienceDir(project: Pick<Project, 'path' | 'agentParams'>, agents: Agent[]) {
  const base = await projectDocBase(project, agents)
  return base && joinPath(base, `${KNOWLEDGE_DIR}/${EXP_DIR}`)
}

const block = (key: string, value: string) => [`${key}: |`, ...value.split('\n').map((l) => (l ? `  ${l}` : ''))]

export function renderExperience(e: ProjectExperience): string {
  return (
    [
      START,
      `id: ${e.id}`,
      `kind: ${e.kind}`,
      `enabled: ${e.enabled}`,
      `source: ${e.source}`,
      `keywords: ${JSON.stringify(e.keywords)}`,
      `paths: ${JSON.stringify(e.paths)}`,
      `taskIds: ${JSON.stringify(e.taskIds)}`,
      `branch: ${e.branch}`,
      `createdAt: ${e.createdAt}`,
      `updatedAt: ${e.updatedAt}`,
      ...block('title', e.title),
      ...block('body', e.body),
      END,
    ].join('\n') + '\n'
  )
}

/** 解析一个文件；结构不对时返回 error（调用方不覆盖、不删这个文件） */
export function parseExperience(text: string): { item?: ProjectExperience; error?: string } {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  let i = lines.findIndex((l) => l.trim() === START)
  if (i < 0) return { error: t('没有 {start} 开始标记', { start: START }) }
  if (lines.slice(0, i).some((l) => l.trim())) return { error: t('第 {n} 行在经验标记之外', { n: 1 }) }
  const fields: Record<string, string> = {}
  i++
  let closed = false
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === END) {
      closed = true
      i++
      break
    }
    if (!line.trim()) {
      i++
      continue
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]?(.*)$/.exec(line)
    if (!m) return { error: t('第 {n} 行不是「字段: 值」的形式：{line}', { n: i + 1, line: line.trim().slice(0, 60) }) }
    i++
    if (m[2].trim() === '|') {
      const parts: string[] = []
      while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('  '))) {
        parts.push(lines[i].startsWith('  ') ? lines[i].slice(2) : '')
        i++
      }
      while (parts.length && !parts[parts.length - 1].trim()) parts.pop()
      fields[m[1]] = parts.join('\n')
    } else fields[m[1]] = m[2].trim()
  }
  if (!closed) return { error: t('缺 {end} 结束标记', { end: END }) }
  if (lines.slice(i).some((l) => l.trim())) return { error: t('第 {n} 行在经验标记之外', { n: i + 1 }) }
  const list = (key: string): unknown => {
    const raw = (fields[key] ?? '').trim()
    if (!raw) return []
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  const title = (fields.title ?? '').trim()
  const p = ProjectExperience.safeParse({
    id: (fields.id ?? '').trim() || `e${hash53(`${title}\n${fields.body ?? ''}`).slice(0, 12)}`,
    kind: fields.kind,
    title,
    body: fields.body ?? '',
    keywords: list('keywords'),
    paths: list('paths'),
    taskIds: list('taskIds'),
    enabled: (fields.enabled ?? '').trim() !== 'false',
    source: fields.source,
    branch: fields.branch ?? '',
    createdAt: fields.createdAt ?? '',
    updatedAt: fields.updatedAt ?? '',
  })
  if (!p.success) return { error: p.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('；') }
  return { item: p.data }
}

export const experienceFileName = (id: string) => `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.md`

interface DirState {
  items: ProjectExperience[]
  files: Map<string, string>
  errors: string[]
}

async function readDir(dir: string): Promise<DirState> {
  const st: DirState = { items: [], files: new Map(), errors: [] }
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.md') && n !== README)
  for (const name of names.sort()) {
    const file = path.join(dir, name)
    const text = await readFile(file, 'utf8').catch((e: Error) => {
      st.errors.push(`${name}：${e.message}`)
      return null
    })
    if (text === null) continue
    const r = parseExperience(text)
    if (!r.item) {
      st.errors.push(`${name}：${r.error}`)
      continue
    }
    if (st.files.has(r.item.id)) continue
    st.items.push(r.item)
    st.files.set(r.item.id, file)
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  st.items.sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))
  return st
}

export interface ExperienceList {
  items: ProjectExperience[]
  /** 格式不对、被跳过的文件 */
  errors: string[]
  /** 存在哪：界面上告诉用户文件在哪个目录 */
  dir?: string
}

export async function loadProjectExperience(
  project: Pick<Project, 'path' | 'agentParams'>,
  agents: Agent[],
): Promise<ExperienceList> {
  const dir = await projectExperienceDir(project, agents)
  if (!dir) return { items: [], errors: [] }
  const st = await readDir(dir)
  return { items: st.items, errors: st.errors, dir }
}

/** 改动一组经验：fn 拿到当前列表（读改写在同一个目录队列里，几个对话同时学到时不互相覆盖），返回要写回的列表 */
export async function mutateProjectExperience<R>(
  project: Pick<Project, 'path' | 'agentParams'>,
  agents: Agent[],
  fn: (items: ProjectExperience[]) => { items: ProjectExperience[]; result: R },
): Promise<{ ok: true; result: R; items: ProjectExperience[] } | { ok: false; error: string }> {
  const dir = await projectExperienceDir(project, agents)
  if (!dir) return { ok: false, error: t('这个项目没有目录，存不了经验') }
  return enqueueWrite(dir, async () => {
    const st = await readDir(dir)
    const { items, result } = fn(st.items.map((x) => ({ ...x })))
    try {
      const keep = new Set<string>()
      if (items.length && !existsSync(path.join(dir, README)))
        await writeTextAtomic(path.join(dir, README), README_TEXT)
      for (const e of items) {
        const file = st.files.get(e.id) ?? path.join(dir, experienceFileName(e.id))
        keep.add(file)
        const text = renderExperience(e)
        if ((await readFile(file, 'utf8').catch(() => '')) !== text) await writeTextAtomic(file, text)
      }
      // 列表里没有了的删掉它的文件；读不出来的文件不在 files 里，不会被删
      for (const file of st.files.values()) if (!keep.has(file)) await unlink(file).catch(() => {})
    } catch (e) {
      return { ok: false as const, error: t('经验文件写入失败：{error}', { error: (e as Error).message }) }
    }
    return { ok: true as const, result, items }
  })
}

/**
 * 两组取并集、截到上限：放不下时这次新学的优先留下（旧实现「旧的在前再截」满了就把新学的全丢了），
 * 留下的按原来的顺序排（旧的在前），界面上看着不乱。大小写不同算同一个
 */
export function unionKeep(old: string[], add: string[], max: number) {
  const key = (s: string) => s.trim().toLowerCase()
  const seen = new Set<string>()
  const all: { v: string; fresh: boolean }[] = []
  const push = (v: string, fresh: boolean) => {
    if (seen.has(key(v))) return
    seen.add(key(v))
    all.push({ v, fresh })
  }
  for (const v of old) push(v, false)
  for (const v of add) push(v, true)
  if (all.length <= max) return all.map((x) => x.v)
  const fresh = all.filter((x) => x.fresh).slice(0, max)
  const keep = new Set([...all.filter((x) => !x.fresh).slice(0, max - fresh.length), ...fresh])
  return all.filter((x) => keep.has(x)).map((x) => x.v)
}

/**
 * 学到的一条：同一件事已经有了就合进那条（关键词、路径取并集，标题说明用新的），否则新加。
 * into：模型点名要更新的那条 id（存在时直接合进它，种类也跟着换）；没点名、按「同一件事」判重合进去的，
 * 种类保持旧的（判重只看路径和关键词，两条种类不同时不该被这次改掉）。
 * before 是并入前的样子：对话里的卡片用它算「这次加了什么」，也用来撤回这次合并
 */
export function mergeLearned(items: ProjectExperience[], add: ProjectExperience, taskId: string, into = '') {
  const named = into ? items.find((x) => x.id === into) : undefined
  const same = named || items.find((x) => sameExperience(x, add))
  if (!same) return { items: [...items, add], added: true, id: add.id, item: add }
  const merged: ProjectExperience = {
    ...same,
    title: add.title,
    body: add.body || same.body,
    kind: named ? add.kind : same.kind,
    keywords: unionKeep(same.keywords, add.keywords, EXP_KEYWORDS_MAX),
    paths: unionKeep(same.paths, add.paths, EXP_PATHS_MAX),
    taskIds: [...new Set([...same.taskIds, taskId])].slice(-10),
    updatedAt: new Date().toISOString(),
  }
  return { items: items.map((x) => (x === same ? merged : x)), added: false, id: same.id, item: merged, before: same }
}
