// Orchestra 的能力类工具（从 shared/engine.ts 的 makeOrchestra 拆出来）。
import { loadCapability } from '../agent-role.ts'
import { normInlinePaths } from '../inline-edit.ts'
import { findLessons } from '../lessons.ts'
import { findExperience } from '../experience.ts'
import { diagnoseTask, loadedCaps } from '../engine-helpers.ts'
import { bindWait, runningStepId } from '../plan.ts'
import { recordRoute } from './route.ts'
import type { Orchestra } from '../engine-host.ts'
import type { OrchCtx } from './ctx.ts'

/** 能力类工具：加载能力、就地微改动、后台命令、开独立分支、请父对话收尾、申请编译、教训和经验 */
export function capabilityTools(oc: OrchCtx) {
  const { host, ctx, self, task, helper, selfAgent, coordinator } = oc
  return {
    loadCapability(name, params) {
      if (helper || !selfAgent) return { ok: false, info: '这里没有挂载的能力' }
      if (!name.trim()) return { ok: false, info: 'name 不能为空：写能力的名字（见角色设定里「你挂载的能力」）' }
      const r = loadCapability(selfAgent, host.agents, name, task.params ?? {}, task.skillSlots ?? {}, params ?? {})
      if (!r.ok) return { ok: false, info: r.text }
      // 同一个会话里已经加载过、参数也没变的不再整段返回：上下文里已经有了，重复贴只占地方
      const key = `${self.id}\u0000${name.trim()}\u0000${JSON.stringify(params ?? {})}`
      const seen = loadedCaps.get(host) ?? new Set<string>()
      loadedCaps.set(host, seen)
      if (seen.has(key)) return { ok: true, info: `「${name.trim()}」这一轮已经加载过，做法见上文` }
      seen.add(key)
      return { ok: true, info: r.text }
    },
    async beginInlineEdit(files, reason, route) {
      if (!coordinator || !host.inlineEdit || selfAgent?.inlineEdit !== 'tiny')
        return { ok: false, info: '这个对话不能就地改文件：把改动交给子对话（create_conversation）' }
      const r = await host.inlineEdit.begin(normInlinePaths(files), reason.trim())
      if (r.ok) recordRoute(host, 'inline-edit', normInlinePaths(files), reason.trim(), route)
      host.changed(true)
      return r
    },
    async endInlineEdit() {
      if (!host.inlineEdit) return { ok: false, info: '这个对话没有就地改动' }
      const r = await host.inlineEdit.end()
      host.changed(true)
      return r
    },
    async runBackground(input) {
      if (!host.runBackground) return { ok: false, info: '这里不能用后台命令，直接执行' }
      if (!input.command.trim()) return { ok: false, info: 'command 是空的' }
      const { step, ...job } = input
      // 归属：调用时点名的步骤优先；子任务没点名就记它自己的步骤 id（运行区据此区分两种来源）；
      // 父对话没点名就挂到当前进行的那一步上——以前不带 step 的长命令在计划里完全看不见，计划还停在上一步
      const owner = step?.trim() || (helper ? self.id : runningStepId(task))
      const r = await host.runBackground(owner ? { ...job, step: owner } : job)
      // 计划里的步骤挂上「等这条命令」：子任务的步骤不在计划里（它是 slot='sub' 的步骤），不挂
      // 常驻服务（开发服务器、监听）一直跑到被停掉：挂上等待的话那一步永远停在等待中
      const wait =
        !helper && !job.service && r.ok && r.id && owner
          ? bindWait(task, owner, { kind: 'background', ref: r.id, label: job.name })
          : ''
      if (r.ok) host.changed(true)
      return { ok: r.ok, info: [r.info, wait].filter(Boolean).join('\n') }
    },
    checkBackground(id) {
      return host.checkBackground ? host.checkBackground(id.trim()) : '这里没有后台命令'
    },
    stopBackground(id) {
      return host.stopBackground ? host.stopBackground(id.trim()) : { ok: false, info: '这里没有后台命令' }
    },
    async beginEdit() {
      if (!host.beginEdit || !ctx.chat || self.parentId) return { ok: false, info: '这个对话不用开独立分支，直接改' }
      const r = await host.beginEdit()
      if (r.ok) host.changed(true)
      return r
    },
    async submitMerge(note, tests, build, handoff, triage, override) {
      if (!host.submitMerge) return { ok: false, info: '只有项目里的子对话能请父对话收尾' }
      const r = await host.submitMerge(note.trim(), tests.trim(), build, handoff, triage, override)
      if (r.ok) host.changed(true)
      return r
    },
    async requestBuild(note, step, children) {
      if (helper || !ctx.chat || !host.ueBuild) return { ok: false, info: '这里不用申请编译' }
      if (!note.trim()) return { ok: false, info: '写清为什么要编译：哪些改动、哪些子对话申请的' }
      const r = await host.ueBuild.request(note.trim(), children)
      const wait = r.ok && r.id && step ? bindWait(task, step, { kind: 'background', ref: r.id, label: '编译' }) : ''
      if (r.ok) host.changed(true)
      return { ok: r.ok, info: [r.info, wait].filter(Boolean).join('\n') }
    },
    lessons: host.lessons
      ? {
          find: async (files, opts) =>
            findLessons(
              await host.lessons!.list(),
              files,
              (await host.lessons!.globals?.()) ?? [],
              opts,
              host.lessons!.hit,
            ),
          record: helper ? undefined : (input) => host.lessons!.record(input),
        }
      : undefined,
    experience: host.experience
      ? {
          find: async (query, files) =>
            findExperience(await host.experience!.list(), query, files, host.experience!.hit),
          list: () => host.experience!.list(),
          record: helper ? undefined : (input) => host.experience!.record(input),
        }
      : undefined,
    // 有项目的普通对话发 /bug 也就地标成 Bug（shared/bug-in-place.ts），同样有这几个工具
    ...(task.bug &&
      (task.parentTaskId || task.projectId) &&
      ctx.chat &&
      !helper && {
        diagnose: (x) => diagnoseTask(host, x),
        bugCase: (x) => diagnoseTask(host, x, true),
        requestLogs: (x) => diagnoseTask(host, x, 'logs'),
      }),
  } satisfies Partial<Orchestra>
}
