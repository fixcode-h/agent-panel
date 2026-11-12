// Orchestra 的对话类工具（从 shared/engine.ts 的 makeOrchestra 拆出来）。
import { kidTitleOf, retryTarget } from '../children/lookup.ts'
import { docsFirst } from '../docs-first.ts'
import { roleKind } from '../agents/role.ts'
import { clip } from '../text.ts'
import { runState, writeRunState } from '../run-state.ts'
import { handedToOther, noteHandOff } from '../peer-message.ts'
import { timeAgo } from '../task.ts'
import { findRole, modeScope, scopeOf } from '../conv-mode.ts'
import { activePlan, bindWait, PARENT_FIX_REF, ensureChildStep } from '../plan.ts'
import { handedOff, SENT_NOTE, recordRoute } from './route.ts'
import type { Orchestra } from '../engine/host.ts'
import type { OrchCtx } from './ctx.ts'

/** 对话类工具：子对话的列表、创建、交代，给父对话传话，父对话之间协调，文件认领，共享状态 */
export function conversationTools(oc: OrchCtx) {
  const { host, ctx, self, task, helper, selfAgent, coordinator } = oc
  return {
    async conversations() {
      if (!coordinator || !host.listConversations) return '（这个对话不能分派子对话）'
      const list = await host.listConversations()
      if (!list.length) return '（还没有子对话）'
      return list
        .map((c) =>
          [
            `- ${c.id}｜${c.title}｜${c.status}`,
            c.summary ? `：${clip(c.summary, 200)}` : '',
            // 在等什么、最后有动静多久了：「是不是卡住了」靠这两项回答，不再让人拿分支时间戳猜
            c.waiting ? `｜${c.waiting}` : '',
            c.doing ? `｜在做：${c.doing}` : '',
            c.lastActivityAt ? `｜最后活动 ${timeAgo(c.lastActivityAt)}` : `｜最近 ${timeAgo(c.at)}`,
          ].join(''),
        )
        .join('\n')
    },
    async createConversation(title, message, files, step, extra) {
      if (!coordinator || !host.createConversation) return { ok: false, info: '这个对话不能创建子对话' }
      if (task.inlineEdit)
        return { ok: false, info: '就地改动还没结束：先改完、提交，调用 end_inline_edit 收尾，再派子对话' }
      if (!message.trim()) return { ok: false, info: 'message 不能为空' }
      // 标题由父对话的 Agent 分析需求后给出，不拿用户原话截断凑数
      if (!title.trim())
        return { ok: false, info: 'title 不能为空：先分析这条需求，起一个能区分任务的短标题，再调用一次' }
      // 子对话失败、被中断后要重试：在原来那个子对话里接着做（用户 2026-10-25 定的），不另起一个「（重试）」
      const again = await retryTarget(host, title)
      if (again)
        return {
          ok: false,
          info: `子对话「${again.title}」（id ${again.id}）${again.status}：重试不要新建子对话，用 send_to_conversation 交回给它（id ${again.id}），它在原来的会话里接着做，已经做完的不用重做。`,
        }
      // 子对话的角色：点名的必须是启用的高级角色（子对话是负责人，要能调度能力），不写由宿主用「执行」
      const roleName = extra?.role?.trim()
      const role = roleName ? findRole(host.agents, roleName, modeScope(task), (a) => a.enabled) : undefined
      if (roleName && (!role || roleKind(role) !== 'advanced' || scopeOf(role) === 'chat')) {
        const names = host.agents
          .filter((a) => a.enabled && roleKind(a) === 'advanced' && !a.canDelegate && scopeOf(a) === 'agent')
          .map((a) => `「${a.name}」`)
          .join('、')
        return {
          ok: false,
          info: `role 写的「${roleName}」不是可用的高级角色${names ? `：可以写 ${names}` : ''}；不写就用「执行」`,
        }
      }
      // 计划里这一步还在等一个没做完的子对话：同一件事交回原来的子对话接着做，不另起一个重做（用户 2026-10-30 定的）。
      // 原来的子对话失败了（起不来、交回时报错）才允许另建一个接手它的活
      const at0 = step?.trim() ? activePlan(task)?.steps.find((s) => s.id === step.trim()) : undefined
      if (at0) {
        const kids = host.listConversations ? await host.listConversations().catch(() => []) : []
        const holder = at0.waits.find(
          (w) =>
            w.kind === 'child' &&
            w.state === 'waiting' &&
            kids.some((k) => k.id === w.ref && !k.resolved && k.state !== 'failed' && k.state !== 'done'),
        )
        if (holder)
          return {
            ok: false,
            info: `计划里「${at0.title}」这一步还在等子对话「${holder.label}」（id ${holder.ref}），它还没做完。用 send_to_conversation 交回它接着做，写清下一步；不要另建一个子对话重做。它确实起不来（交回时报错、状态是失败）再另建，并在派单里写明接手的是哪个子对话的活。`,
          }
      }
      const docs = await docsFirst(
        extra ?? {},
        host.moduleDocs,
        selfAgent?.params.find((p) => p.key === 'docsFirst')?.default === true,
      )
      if (docs.block) return { ok: false, info: docs.block }
      const r = await host.createConversation({
        title: title.trim(),
        message: message + (docs.note ?? ''),
        files,
        ...(role && { agentId: role.id }),
        ...(extra?.bug && { bug: true }),
        ...(extra?.fix && !extra.bug && { fix: true }),
        ...(extra?.edits && { edits: true }),
        ...(extra?.ignoreDirty && { ignoreDirty: true }),
        ...(extra?.bug && extra.level && { level: extra.level }),
        ...(extra?.after?.length && { after: extra.after }),
      })
      if (r.ok && r.id) recordRoute(host, 'child', [r.id], title.trim(), extra?.route)
      // 不另记系统消息：对话里这次工具调用本身显示成「新建子对话 标题」
      // 没指定步骤就挂到计划里能对上的一步；对不上（或者计划已经结束）由 ensureChildStep 自动补一步，
      // 不然这一步一标完成，父对话的计划就「已完成」了，子对话却还没合回（用户报过：一堆子对话在跑、计划面板还停在旧状态）
      const at = r.ok && r.id ? step?.trim() || ensureChildStep(task, r.id, title) : ''
      const wait = r.ok && r.id && at ? bindWait(task, at, { kind: 'child', ref: r.id, label: title.trim() }) : ''
      if (r.ok) host.changed(true)
      // 没写级别：子对话按标准走，一行就能修的 Bug 也要确认根因、方案两道（实测 2026-11-05）
      const level =
        r.ok && extra?.bug && !extra.level
          ? '没写 level：子对话按「标准」级别查。下次派 Bug 按「Bug 怎么交」的级别初判写上 level，快速级别根因和方案合成一次确认。'
          : ''
      return { ok: r.ok, id: r.id, info: [r.info, r.ok && docs.info, wait, level].filter(Boolean).join('\n') }
    },
    async sendToConversation(id, message, step, route, bug) {
      if (!coordinator || !host.sendToConversation) return { ok: false, info: '这个对话不能给子对话发消息' }
      if (!message.trim()) return { ok: false, info: 'message 不能为空' }
      // 一条消息只交给一个子对话（用户 2026-10-24 定的）：同一段话逐个转给几个子对话，
      // 父对话里刷出一排一模一样的「发送消息」，几个子对话还会各改各的同一处
      // 并行发出的几次调用可能还没记进对话：这一轮已经交出去的也记在内存里一起查
      let handed = handedOff.get(task)
      if (!handed) handedOff.set(task, (handed = new Map()))
      const other = handedToOther(task.messages, handed, id.trim(), message)
      if (other)
        return {
          ok: false,
          info: `这段话已经交给了子对话 ${other}，一条消息只交给一个子对话：选最相关的那一个交，别的子对话不用重复发。`,
        }
      noteHandOff(task.messages, handed, id.trim(), message)
      const r = await host.sendToConversation(id.trim(), message, bug)
      if (!r.ok) handed.delete(message.trim())
      // 标题从子对话列表里取：补步骤时用它当标题（只看 id 的话计划里会出现「子对话：c1」这种没信息量的标题）
      const kidTitle = r.ok ? await kidTitleOf(host, id.trim()) : ''
      const at = r.ok ? step?.trim() || ensureChildStep(task, id.trim(), kidTitle) : ''
      const wait = r.ok && at ? bindWait(task, at, { kind: 'child', ref: id.trim(), label: kidTitle || id.trim() }) : ''
      if (r.ok) recordRoute(host, 'resend', [id.trim()], kidTitle || id.trim(), route)
      if (r.ok) host.changed(true)
      // 送没送到、之后怎么做由返回自己说清（以前写在协调器设定里一整节教它读返回值，ADR 0048 删掉了那一节）
      const info = r.ok ? `${r.info}\n${SENT_NOTE}${wait ? `\n${wait}` : ''}` : r.info
      return { ok: r.ok, info }
    },
    async toParent(text, question, options, kind, waitFix) {
      if (!host.messageParent) return { ok: false, info: '这个对话没有父对话' }
      if (!text.trim()) return { ok: false, info: 'text 不能为空' }
      const at = waitFix?.trim()
      // 写明这是要父对话分派修复的报错：父对话按「编译、测试报错的分派」规则找改出它的子对话（见 shared/fix-route.ts）
      const body = at ? `【报错不是我改出来的，请安排修复后通知我】\n${text.trim()}` : text.trim()
      const r = await host.messageParent(body, question, options, kind, !!at)
      if (!r.ok || !at) return r
      const wait = bindWait(task, at, { kind: 'parent', ref: PARENT_FIX_REF, label: '父对话安排修复' })
      host.changed(true)
      return {
        ok: true,
        info: `${r.info}\n${wait}父对话安排好修复会发消息给你，那时这一步退回进行中，你再重跑它的编译 / 测试。`,
      }
    },
    async finishChild(id) {
      if (helper || !ctx.chat || !host.finishChild) return { ok: false, info: '这个对话没有子对话可以收尾' }
      // 就地改动期间不合回子对话：合并和就地改动搅在同一个工作区里，改动算不清、也可能互相覆盖
      if (task.inlineEdit)
        return { ok: false, info: '你在就地改动：先改完、提交，调用 end_inline_edit 收尾，再收尾子对话' }
      if (!id) return { ok: false, info: 'id 是空的：写子对话的 id（收尾请求里有）' }
      const r = await host.finishChild(id)
      host.changed(true)
      return r
    },
    async listPeers() {
      if (!host.peers) return '（这个对话不能联系其他父对话）'
      const list = await host.peers()
      if (!list.length) return '（这个项目里没有别的父对话）'
      return list
        .map(
          (p) =>
            `- ${p.id}｜${p.title}｜${p.busy ? '执行中' : p.status}${p.building ? `｜占着编译：${p.building}` : ''}`,
        )
        .join('\n')
    },
    async messagePeer(id, text) {
      if (!host.messagePeer) return { ok: false, info: '这个对话不能联系其他父对话' }
      if (!text.trim()) return { ok: false, info: 'text 不能为空' }
      return host.messagePeer(id.trim(), text.trim())
    },
    claim(paths) {
      if (!host.claimFiles) return { ok: false, info: '这个对话不需要认领文件' }
      const list = paths.map((p) => p.trim()).filter(Boolean)
      if (!list.length) return { ok: false, info: 'paths 是空的：写要改的文件或目录（相对项目根）' }
      const r = host.claimFiles(list)
      const lines = [
        r.granted.length ? `已认领：${r.granted.join('、')}` : '',
        r.held.length
          ? `被其他子对话占着（不要改）：${r.held.map((h) => `${h.path}（「${h.by}」${h.state ? `，${h.state}` : ''}）`).join('、')}。认领留到对方的改动被父对话验收才释放：先做别的部分；对方已停下或在等验收、你又绕不开时，用 message_parent（question 设为 true）请父对话协调。`
          : '',
      ]
      return { ok: !r.held.length, info: lines.filter(Boolean).join('\n') }
    },
    release(paths) {
      if (!host.releaseFiles) return { ok: false, info: '这个对话不需要认领文件' }
      const n = host.releaseFiles(paths.map((p) => p.trim()).filter(Boolean))
      return { ok: true, info: n ? `已释放 ${n} 条认领` : '没有可释放的认领（改过的文件等父对话验收后释放）' }
    },
    readState() {
      const entries = Object.entries(runState(task))
      if (!entries.length) return '（共享状态还是空的）'
      return entries
        .map(([k, v]) => `- ${k}（v${v.version}，${v.by || '未知节点'} 写入，${v.at}）：\n${clip(v.value, 4000)}`)
        .join('\n\n')
    },
    writeState: (key, value) => writeRunState(host, self.id, key, value),
  } satisfies Partial<Orchestra>
}
