import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  EXPERIENCE_KINDS,
  type ExperienceInput,
  EXP_PATHS_MAX,
  ExperienceSettings,
  MAX_EXPERIENCES,
  ProjectExperience,
  experienceProblems,
  globBase,
  newExperienceId,
  rankExperience,
} from '../shared/experience.ts'
import { digestOf, digestText, gateReason, landingCovered, type TraceTool } from '../shared/experience-gate.ts'
import { branchNameOf } from '../shared/doc-root.ts'
import { t } from '../shared/i18n.ts'
import type { Agent, Project, Task } from '../shared/schema.ts'
import { askOnce, experienceRun, learnPrompt, parseLearned, type LearnedItem } from './experience-ai.ts'
import { loadProjectExperience, mergeLearned, mutateProjectExperience } from './project-experience.ts'
import { detectVcs } from './projects-analyze.ts'
import { getSettings } from './settings.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'
import { log } from './log.ts'

/**
 * 整个对话完成后学经验（设计稿 §6）：
 * 1. 顶层对话一轮结束就排一次，空闲够久（设置里的分钟数）再看——这期间用户追问了、对话又跑起来了就重排；
 * 2. 到点时整个对话（含所有子对话、工作流）必须是「已完成」，否则不学；
 * 3. 只看上次学过之后的新工具调用，先机械摘要和过闸门（不花 token），过了才调一次模型提炼；
 * 4. 学到的条目按规矩校验、路径必须存在，合进已有的同一件事或新加，结果在对话里写一行。
 * 学过的时间记在数据目录 experience-state.json：同一段对话不会反复学。
 */

type Lister<T> = { list(): Promise<T[]>; get(id: string): Promise<T | null> }

export interface LearnDeps {
  /** 整份任务（含消息） */
  getTask(id: string): Promise<Task | null>
  /** 任务列表（只用 id 和 parentTaskId 找子对话） */
  listTasks(): Promise<Pick<Task, 'id' | 'parentTaskId'>[]>
  /** 整个对话现在是不是「已完成」（含子对话、后台命令、工作流） */
  isDone(task: Task): Promise<boolean>
  projects: Lister<Project>
  agents: Lister<Agent>
  /** 在对话里写一行：学到了什么，或者提炼失败的原因 */
  note(taskId: string, text: string, error?: string): Promise<void>
}

const STATE_FILE = () => path.join(DATA_DIR, 'experience-state.json')
interface LearnState {
  /** 顶层对话 id → 学到哪个时刻为止（消息的 at） */
  learned: Record<string, string>
  /** 项目 id → 当天提炼了几次 */
  daily: Record<string, { day: string; count: number }>
}

async function readState(): Promise<LearnState> {
  const raw = (await readJson(STATE_FILE()).catch(() => undefined)) as Partial<LearnState> | undefined
  return { learned: raw?.learned ?? {}, daily: raw?.daily ?? {} }
}

let stateChain: Promise<unknown> = Promise.resolve()
function updateState(fn: (s: LearnState) => void) {
  const run = stateChain.then(async () => {
    const s = await readState()
    fn(s)
    // 只留最近的 2000 个对话：删掉的对话不用一直记着
    const keys = Object.keys(s.learned)
    if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete s.learned[k]
    await writeJsonAtomic(STATE_FILE(), s)
  })
  stateChain = run.catch(() => {})
  return run
}

const today = () => new Date().toISOString().slice(0, 10)

/** 落点目录往下两级的结构：交给模型判断「哪个目录是这类东西的家」，最多 80 行 */
async function treeOf(root: string, dirs: string[]) {
  const out: string[] = []
  for (const d of dirs) {
    const walk = async (rel: string, depth: number) => {
      if (out.length >= 80) return
      const names = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])
      for (const n of names.slice(0, 30)) {
        if (out.length >= 80) return
        if (n.name.startsWith('.')) continue
        const r = rel ? `${rel}/${n.name}` : n.name
        out.push(`${'  '.repeat(depth)}${n.isDirectory() ? `${n.name}/` : n.name}`)
        if (n.isDirectory() && depth < 1) await walk(r, depth + 1)
      }
    }
    out.push(`${d}/`)
    await walk(d, 1)
  }
  return out.join('\n')
}

/** 路径还在不在：命令类的不查；glob 查它的固定前缀 */
async function pathExists(root: string, p: string) {
  const base = globBase(p)
  if (!base) return false
  return stat(path.join(root, base))
    .then(() => true)
    .catch(() => false)
}

/** 学到的一条按规矩整理：裁掉超长的、去掉不存在的路径；不合格返回原因 */
export async function shapeLearned(
  item: LearnedItem,
  root: string,
  extra: Pick<ProjectExperience, 'branch'> & { taskId: string },
): Promise<{ item?: ProjectExperience; why?: string }> {
  let paths = item.paths.slice(0, EXP_PATHS_MAX)
  if (item.kind !== 'command') {
    const ok: string[] = []
    for (const p of paths) if (await pathExists(root, p)) ok.push(p)
    if (paths.length && !ok.length) return { why: t('路径都不存在：{paths}', { paths: paths.join('、') }) }
    paths = ok
  }
  const now = new Date().toISOString()
  const draft = {
    id: newExperienceId(),
    kind: item.kind,
    title: item.title.slice(0, 60),
    body: item.body.slice(0, 300),
    keywords: [...new Set(item.keywords.map((k) => k.slice(0, 30)))].slice(0, 8),
    paths,
    enabled: true,
    source: 'auto' as const,
    taskIds: [extra.taskId],
    branch: extra.branch,
    createdAt: now,
    updatedAt: '',
  }
  const problems = experienceProblems(draft)
  if (problems.length) return { why: problems.join('；') }
  const p = ProjectExperience.safeParse(draft)
  return p.success ? { item: p.data } : { why: p.error.issues.map((x) => x.message).join('；') }
}

export function createExperienceLearner(deps: LearnDeps) {
  const timers = new Map<string, NodeJS.Timeout>()
  /** 每个项目同时只跑一个提炼：几个对话同时完成时排队，不同时起好几个 CLI */
  const running = new Map<string, Promise<unknown>>()

  /** 顶层对话一轮结束时调：重新计时，空闲够久再看要不要学 */
  async function schedule(taskId: string) {
    const exp = ExperienceSettings.parse((await getSettings().catch(() => null))?.experience ?? {})
    clearTimeout(timers.get(taskId))
    timers.delete(taskId)
    if (!exp.enabled || !exp.autoLearn) return
    const timer = setTimeout(() => {
      timers.delete(taskId)
      void learn(taskId).catch((e) => log.warn('task', '学经验失败', { task: taskId, error: (e as Error).message }))
    }, exp.idleMinutes * 60_000)
    timer.unref?.()
    timers.set(taskId, timer)
  }

  /** 这个对话和它所有子对话：只在顶层对话上学，子对话里的工具调用一起算 */
  async function treeOfTasks(root: Task) {
    const all = await deps.listTasks()
    const ids = [root.id]
    for (let i = 0; i < ids.length; i++) for (const x of all) if (x.parentTaskId === ids[i]) ids.push(x.id)
    const out: Task[] = [root]
    for (const id of ids.slice(1)) {
      const tk = await deps.getTask(id)
      if (tk) out.push(tk)
    }
    return out
  }

  async function learn(taskId: string): Promise<string> {
    const task = await deps.getTask(taskId)
    if (!task || task.parentTaskId || !task.projectId || task.archived || task.deletedAt) return 'skip'
    const settings = await getSettings()
    const exp = ExperienceSettings.parse(settings.experience ?? {})
    if (!exp.enabled || !exp.autoLearn) return 'off'
    if (!(await deps.isDone(task))) return 'not-done'
    const project = await deps.projects.get(task.projectId)
    if (!project?.path) return 'no-project'
    const prev = running.get(project.id) ?? Promise.resolve()
    const job = prev.catch(() => {}).then(() => learnIn(task, project, exp, settings))
    running.set(project.id, job)
    void job.finally(() => running.get(project.id) === job && running.delete(project.id)).catch(() => {})
    return job
  }

  async function learnIn(
    task: Task,
    project: Project,
    exp: ExperienceSettings,
    settings: Awaited<ReturnType<typeof getSettings>>,
  ): Promise<string> {
    const st = await readState()
    const since = st.learned[task.id] ?? ''
    const tasks = await treeOfTasks(task)
    const trace: TraceTool[] = []
    let last = since
    for (const tk of tasks) {
      const roots = [project.path, tk.worktree?.path ?? ''].filter(Boolean)
      for (const m of tk.messages) {
        if (!m.at || m.at <= since) continue
        if (m.at > last) last = m.at
        for (const tool of m.tools) trace.push({ tool, roots })
      }
    }
    if (!trace.length) return 'nothing'
    const mark = () => updateState((s) => void (s.learned[task.id] = last))
    const digest = digestOf(trace)
    const reason = gateReason(digest, exp.sensitivity)
    if (!reason) {
      await mark()
      return 'gate'
    }
    const agents = await deps.agents.list()
    const current = await loadProjectExperience(project, agents)
    // 已有的经验已经覆盖这次的落点：不用再花一次模型调用
    if (
      !digest.commands.length &&
      landingCovered(
        digest,
        current.items.filter((e) => e.enabled).flatMap((e) => e.paths),
      )
    ) {
      await mark()
      return 'covered'
    }
    if (current.items.length >= MAX_EXPERIENCES) {
      await mark()
      await deps.note(
        task.id,
        t('经验已经有 {n} 条，这次没再学：先到项目设置的「经验」里用 AI 评审清理一下', { n: MAX_EXPERIENCES }),
      )
      return 'full'
    }
    const day = today()
    const used = st.daily[project.id]?.day === day ? st.daily[project.id].count : 0
    if (used >= exp.dailyLimit) {
      log.info('task', '今天的经验提炼次数用完了，这次不学', { task: task.id, project: project.id })
      await mark()
      return 'limit'
    }
    await updateState((s) => void (s.daily[project.id] = { day, count: used + 1 }))
    const firstUser = task.messages.find((m) => m.role === 'user')
    const request = (firstUser?.text ?? '').slice(0, 300)
    const related = rankExperience(
      current.items,
      [request, ...digest.landing, ...digest.searches.slice(-10)].join(' '),
    ).slice(0, 8)
    const agent = agents.find((a) => a.id === task.agentId)
    const run = experienceRun(exp, settings, agent, task)
    const prompt = learnPrompt({
      request,
      digest: digestText(digest, reason),
      tree: await treeOf(project.path, digest.landing),
      related,
    })
    const res = await askOnce(run, settings, prompt)
    // 失败也记下学到哪了：同一段对话不会每次空闲都再失败一次；用户在对话里能看到原因
    await mark()
    if (res.error) {
      await deps.note(task.id, t('经验提炼失败，没有重试'), res.error)
      return 'error'
    }
    const parsed = parseLearned(res.text)
    if (parsed.error) {
      await deps.note(
        task.id,
        t('经验提炼失败：模型的回复格式不对，没有重试'),
        `${parsed.error}\n\n${res.text.slice(0, 2000)}`,
      )
      return 'error'
    }
    if (!parsed.items.length) return 'none'
    const vcs = (await detectVcs(project.path).catch(() => null))?.vcs
    const branch = vcs === 'p4' || vcs === 'svn' ? branchNameOf(project.path) : ''
    const shaped: { item: ProjectExperience; update?: string }[] = []
    const dropped: string[] = []
    for (const it of parsed.items) {
      const r = await shapeLearned(it, project.path, { branch, taskId: task.id })
      if (r.item) shaped.push({ item: r.item, update: it.op === 'update' ? it.id : undefined })
      else dropped.push(`${it.title}：${r.why}`)
    }
    if (dropped.length) log.info('task', '学到的经验不合规矩，丢掉了', { task: task.id, dropped })
    if (!shaped.length) return 'none'
    const saved = await mutateProjectExperience(project, agents, (items) => {
      let list = items
      const titles: string[] = []
      for (const s of shaped) {
        // 模型点名要更新的那条按 id 合进去；没点名的按「同一件事」判重
        list = mergeLearned(list, s.item, task.id, s.update).items
        titles.push(s.item.title)
      }
      return { items: list, result: titles }
    })
    if (!saved.ok) {
      await deps.note(task.id, t('学到的经验没能保存'), saved.error)
      return 'error'
    }
    await deps.note(task.id, t('学到经验：{titles}', { titles: saved.result.join('；') }))
    return 'learned'
  }

  return { schedule, learn }
}

/**
 * Agent 用 record_experience 记一条（用户发 /learn 让它学一件事）：和自动学到的走同一套整理（字数、路径必须存在），
 * 带 id 时更新那一条，否则同一件事合进已有的、不是就新加。用户点名要学的，标成「手动」
 */
export async function recordExperience(
  project: Project,
  agents: Agent[],
  input: ExperienceInput,
  taskId: string,
): Promise<{ ok: boolean; info: string }> {
  const kind = EXPERIENCE_KINDS.find((k) => k === input.kind)
  if (!kind) return { ok: false, info: `kind 只能是 ${EXPERIENCE_KINDS.join(' / ')}` }
  const vcs = (await detectVcs(project.path).catch(() => null))?.vcs
  const branch = vcs === 'p4' || vcs === 'svn' ? branchNameOf(project.path) : ''
  const r = await shapeLearned(
    {
      op: input.id ? 'update' : 'add',
      id: input.id ?? '',
      kind,
      title: input.title.trim(),
      body: input.body.trim(),
      keywords: input.keywords,
      paths: input.paths,
    },
    project.path,
    { branch, taskId },
  )
  if (!r.item) return { ok: false, info: `没记下：${r.why}。按「经验记什么」改好再记` }
  const item = { ...r.item, source: 'user' as const }
  const saved = await mutateProjectExperience(project, agents, (items) => {
    if (input.id && !items.some((x) => x.id === input.id)) return { items, result: '' }
    const m = mergeLearned(items, item, taskId, input.id ?? '')
    return { items: m.items, result: m.id }
  })
  if (!saved.ok) return { ok: false, info: saved.error }
  if (!saved.result)
    return { ok: false, info: `没有 id 为 ${input.id} 的经验：先用 project_experience 查到它的 id，新记一条就不带 id` }
  return { ok: true, info: `已记下经验（id: ${saved.result}）：${item.title}` }
}
