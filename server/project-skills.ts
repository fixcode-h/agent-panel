/**
 * 项目里的 Skill：项目设置「Skill」分节用。
 * 只碰各 Agent 定义里的 skills.repo 目录（`.agents/skills`、`.claude/skills`……），
 * 名字和目录都按白名单校验，不能借这个接口读写项目里的其他文件。
 */
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { Project } from '../shared/schema.ts'
import { t } from '../shared/i18n.ts'
import {
  projectSkillName,
  projectSkillRepos,
  skillIssues,
  skillTemplate,
  type ProjectSkill,
  type ProjectSkillsView,
} from '../shared/project-skills.ts'
import { frontField } from '../shared/library.ts'
import { extraFiles } from './library.ts'
import { clearSlashCache } from './slash.ts'

/** 技能列表：能放技能的目录（现在存不存在）+ 各目录下的技能 */
const MAX = 60_000

/** 项目目录：没填、不是绝对路径或者已经不在了，都当没有 */
function projectDir(project: Project | null) {
  const dir = project?.path.trim() ?? ''
  return dir && existsSync(dir) ? dir : ''
}

/** 一个技能的位置：目录必须是 Agent 定义里的项目技能目录，名字必须是合法的文件夹名 */
function skillPath(root: string, repo: string, name: string) {
  const known = projectSkillRepos().find((r) => r.dir.replaceAll('\\', '/') === repo)
  if (!known) throw new Error(t('这个目录不能放 Skill：{dir}', { dir: repo }))
  if (!projectSkillName(name)) throw new Error(t('名字只能用字母、数字、. _ -，以字母或数字开头'))
  const dir = path.join(root, known.dir, name)
  if (path.relative(root, dir).startsWith('..')) throw new Error(t('名字不对'))
  return { dir, file: path.join(dir, 'SKILL.md') }
}

async function scanRepo(root: string, repo: { dir: string; clis: string[] }): Promise<ProjectSkill[]> {
  const base = path.join(root, repo.dir)
  if (!existsSync(base)) return []
  const out: ProjectSkill[] = []
  for (const e of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const file = path.join(base, e.name, 'SKILL.md')
    const text = (await readFile(file, 'utf8').catch(() => '')).replace(/^\ufeff/, '')
    if (!text) continue
    out.push({
      name: e.name,
      description: frontField(text, 'description'),
      path: file,
      dir: path.posix.join(repo.dir.replaceAll('\\', '/'), e.name),
      source: repo.dir.replaceAll('\\', '/'),
      clis: repo.clis,
      issues: skillIssues(e.name, text),
    })
  }
  return out
}

export async function listProjectSkills(root: string): Promise<ProjectSkillsView> {
  const repos = projectSkillRepos().map((r) => ({ ...r, exists: existsSync(path.join(root, r.dir)) }))
  const skills = (await Promise.all(repos.map((r) => scanRepo(root, r)))).flat()
  return {
    path: root,
    repos,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir)),
  }
}

export async function readProjectSkill(root: string, repo: string, name: string) {
  const p = skillPath(root, repo, name)
  if (!existsSync(p.file)) throw new Error(t('没有这一项'))
  const content = (await readFile(p.file, 'utf8')).replace(/^\ufeff/, '')
  return { content, files: await extraFiles(p.dir) }
}

export async function writeProjectSkill(root: string, repo: string, name: string, content: string, create: boolean) {
  const p = skillPath(root, repo, name)
  if (create && existsSync(p.file)) throw new Error(t('「{name}」已经有了', { name }))
  await mkdir(p.dir, { recursive: true })
  // 技能里的脚本要在 WSL / Linux 里跑，一律 LF、UTF-8：跟着项目设置写 CRLF 会让带 shebang 的脚本坏掉
  await writeFile(p.file, content.replace(/\r\n?/g, '\n'), 'utf8')
  clearSlashCache()
  return { dir: path.posix.join(repo, name) }
}

/** 新建技能：SKILL.md 先按骨架写好，脚本目录等用户自己加 */
export async function createProjectSkill(root: string, repo: string, name: string, description = '') {
  return writeProjectSkill(root, repo, name, skillTemplate(name, description), true)
}

export async function deleteProjectSkill(root: string, repo: string, name: string) {
  const p = skillPath(root, repo, name)
  if (!existsSync(p.dir)) return
  clearSlashCache()
  // 软链接的 Skill 只删链接，不动链接指向的原文件夹
  return (await lstat(p.dir)).isSymbolicLink() ? unlink(p.dir) : rm(p.dir, { recursive: true })
}

export function projectSkillsApi(deps: { projects: { get(id: string): Promise<Project | null> } }) {
  const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)
  /** 每次请求按 projectId 取项目目录：项目路径改过后不会用到旧目录 */
  const rootOf = async (id: string) => {
    const project = id ? await deps.projects.get(id) : null
    const root = projectDir(project)
    if (!root) throw new Error(t('先在项目设置里填好项目目录'))
    return root
  }
  const guard = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c)
    } catch (e) {
      return bad(c, (e as Error).message)
    }
  }
  const name = (c: Context) => c.req.query('name') ?? ''
  const repo = (c: Context) => c.req.query('repo') ?? ''
  const ProjectSkillInput = z.object({
    projectId: z.string().default(''),
    repo: z.string().min(1),
    name: z.string().min(1),
    content: z.string().max(MAX).optional(),
    description: z.string().max(1000).optional(),
  })
  return new Hono()
    .get(
      '/',
      guard(async (c) => {
        const id = c.req.query('projectId') ?? ''
        // 项目目录没填时列表空着，不报错：新建项目还没保存也能打开这个分节
        const root = projectDir(id ? await deps.projects.get(id) : null)
        if (!root) return c.json({ path: '', repos: [], skills: [] } satisfies ProjectSkillsView)
        return c.json(await listProjectSkills(root))
      }),
    )
    .get(
      '/file',
      guard(async (c) => {
        const root = await rootOf(c.req.query('projectId') ?? '')
        return c.json(await readProjectSkill(root, repo(c), name(c)))
      }),
    )
    .put(
      '/file',
      guard(async (c) => {
        const b = ProjectSkillInput.safeParse(await c.req.json().catch(() => ({})))
        if (!b.success) return bad(c, z.prettifyError(b.error))
        const root = await rootOf(b.data.projectId)
        const content = b.data.content ?? ''
        if (!content.trim()) return bad(c, t('SKILL.md 不能为空'))
        // PUT 只改已有的：新建走 POST，那里会先套骨架模板
        return c.json({ ok: true, ...(await writeProjectSkill(root, b.data.repo, b.data.name, content, false)) })
      }),
    )
    .post(
      '/',
      guard(async (c) => {
        const p = z
          .object({
            projectId: z.string().default(''),
            repo: z.string().min(1),
            name: z.string().min(1),
            description: z.string().max(1000).default(''),
          })
          .safeParse(await c.req.json().catch(() => ({})))
        if (!p.success) return bad(c, z.prettifyError(p.error))
        const root = await rootOf(p.data.projectId)
        return c.json(await createProjectSkill(root, p.data.repo, p.data.name, p.data.description), 201)
      }),
    )
    .delete(
      '/file',
      guard(async (c) => {
        const root = await rootOf(c.req.query('projectId') ?? '')
        await deleteProjectSkill(root, repo(c), name(c))
        return c.json({ ok: true })
      }),
    )
}
