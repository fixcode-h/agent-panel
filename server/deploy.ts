/**
 * 设置里的「部署」：全局说明写进各 CLI 的用户目录，选中的自带 Skill 放到 ~/.agents/skills/<分类>/<名字>/。
 * 配置存在 config/deploy.json；全局说明的 AI 生成 / 优化复用项目说明文件的那套任务（/doc-jobs 查进度）。
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { CLIS, type CliDefinition } from '../shared/clis.ts'
import {
  composeAgentsMd,
  DeployConfig,
  DeployRun,
  deployTemplate,
  GlobalDocOptimize,
  globalDocPrompt,
  SKILL_TARGET,
  type DeployResult,
  type DeployState,
  type DeployStatus,
} from '../shared/deploy.ts'
import { frontField } from '../shared/library.ts'
import { entries, statusIn, writeSkill, type Entry } from './bundled-skills.ts'
import { expandHome } from './cli-extras.ts'
import { log } from './log.ts'
import { dataPath, readJson, writeJsonAtomic } from './store.ts'

const FILE = dataPath('config/deploy.json')
const docClis = () => CLIS.filter((d) => d.globalDoc)
const docPath = (d: CliDefinition) => expandHome(d.globalDoc!)
const skillRoot = () => expandHome(SKILL_TARGET)

/** 没保存过时：全局说明用内置的通用约束，CLI 选用户目录已经存在的（装过的） */
async function loadConfig(): Promise<DeployConfig> {
  const raw = await readJson(FILE)
  const c = DeployConfig.safeParse(raw ?? {})
  const cfg = c.success ? c.data : DeployConfig.parse({})
  if (raw === undefined) cfg.agentsMd = deployTemplate()
  if (!cfg.clis.length)
    cfg.clis = docClis()
      .filter((d) => existsSync(path.dirname(docPath(d))))
      .map((d) => d.id)
  return cfg
}

const describe = (e: Entry) => ({
  name: e.name,
  category: e.category,
  description: frontField(e.files.get('SKILL.md')!.toString('utf8'), 'description'),
})

async function fileStatus(file: string, content: string): Promise<DeployStatus> {
  const cur = await readFile(file, 'utf8').catch(() => null)
  return cur === null ? 'missing' : cur === content ? 'same' : 'changed'
}

async function state(): Promise<DeployState> {
  const config = await loadConfig()
  const all = await entries()
  const root = skillRoot()
  const skills = await Promise.all(
    all.map(async (e) => ({
      ...describe(e),
      files: e.files.size - 1,
      status: await statusIn(e, path.join(root, e.category)),
    })),
  )
  skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  const content = composeAgentsMd(config.agentsMd, all.filter((e) => config.skills.includes(e.name)).map(describe))
  const targets = await Promise.all(
    docClis().map(async (d) => ({
      cli: d.id,
      name: d.name,
      path: docPath(d),
      status: await fileStatus(docPath(d), content),
    })),
  )
  return { config, template: deployTemplate(), skillRoot: root, skills, targets }
}

export async function deploy(run: DeployRun): Promise<DeployResult> {
  const all = await entries()
  const root = skillRoot()
  const out: DeployResult = { skills: [], kept: [], removed: [], docs: [] }
  for (const e of all) {
    const dir = path.join(root, e.category)
    const s = await statusIn(e, dir)
    if (run.skills.includes(e.name)) {
      if (s === 'same') continue
      if (s === 'changed' && !run.overwrite) {
        out.kept.push(e.name)
        continue
      }
      await rm(path.join(dir, e.name), { recursive: true, force: true })
      await writeSkill(e, dir)
      out.skills.push(e.name)
    } else if (s === 'same') {
      // 取消勾选就是不要了；只移除和自带的完全一样的，改过的留给用户自己处理
      await rm(path.join(dir, e.name), { recursive: true, force: true })
      out.removed.push(e.name)
    } else if (s === 'changed') out.kept.push(e.name)
  }
  const content = composeAgentsMd(run.agentsMd, all.filter((e) => run.skills.includes(e.name)).map(describe))
  if (content.trim())
    for (const d of docClis().filter((x) => run.clis.includes(x.id))) {
      const file = docPath(d)
      const s = await fileStatus(file, content)
      if (s === 'same') {
        out.docs.push({ cli: d.id, path: file, result: 'same' })
        continue
      }
      await mkdir(path.dirname(file), { recursive: true })
      // 原来的文件可能是用户自己写的，先备份
      const backup = s === 'changed' ? `${file}.bak` : undefined
      if (backup) await copyFile(file, backup)
      await writeFile(file, content)
      out.docs.push({ cli: d.id, path: file, result: s === 'missing' ? 'created' : 'updated', backup })
    }
  log.info('deploy', '部署完成', {
    skills: out.skills.length,
    removed: out.removed.length,
    docs: out.docs.filter((x) => x.result !== 'same').length,
  })
  return out
}

export function deployApi(deps: {
  startDoc: (c: Context, input: GlobalDocOptimize & { path: string; prompt: string }, dir: string) => Promise<Response>
}) {
  const bad = (c: Context, error: string) => c.json({ error }, 400)
  const save = async (raw: unknown) => {
    const p = DeployConfig.safeParse(raw)
    if (!p.success) throw new Error(z.prettifyError(p.error))
    await writeJsonAtomic(FILE, p.data)
    return p.data
  }
  return new Hono()
    .get('/', async (c) => c.json(await state()))
    .put('/', async (c) => {
      try {
        await save(await c.req.json())
        return c.json(await state())
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
    .post('/run', async (c) => {
      const p = DeployRun.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      try {
        await save(p.data)
        const result = await deploy(p.data)
        return c.json({ result, state: await state() })
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
    .post('/optimize', async (c) => {
      const p = GlobalDocOptimize.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const readers = docClis().map((d) => d.name)
      // 在用户目录里只读运行：全局说明和具体项目无关
      return deps.startDoc(c, { ...p.data, path: 'AGENTS.md', prompt: globalDocPrompt(p.data, readers) }, homedir())
    })
}
