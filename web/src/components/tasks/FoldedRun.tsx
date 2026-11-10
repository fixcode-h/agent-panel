/**
 * 一轮回复和它收尾后的折叠（设计稿：项目共享目录 designs/回复折叠与派单行重设计-设计稿.md）：
 * ChatReply 把一轮切成几段，FoldedRun 按 web/src/lib/fold.ts 的 foldLayout 把一段摆出来。
 * 从 Messages.tsx 拆出来：那边只留单条消息、过程行和运行区
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Task, TaskMessage } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { useData } from '@/lib/data'
import { useAiLook } from '@/lib/ai-look'
import { useAgentView } from '@/lib/agent-view'
import {
  addFoldCut,
  foldCuts,
  foldLayout,
  keptOut,
  replyText,
  segOpenOf,
  splitFolds,
  toggleSegOpen,
  unfoldedText,
  type FoldPart,
} from '@/lib/fold'
import { dispatchKey, staysOut } from '@/lib/fold-dispatch'
import { dedupePeerReports } from '@/lib/peer-dedupe'
import { ReplyFrame } from '@/components/chat/ChatMessage'
import { AgentMessage, inlineEntry, lastIndex, Msgs, RunningFooter, StickyAuthor, type Author } from './Messages'
import { NoteMessage } from './SystemNote'
import { ToolRow } from './ToolRow'
import { runningTools } from './RunningNow'
import { ConvChangesCard } from './TurnChanges'
import { useEffortOf } from './ChatModelPicker'
import { DispatchSlot, InlineRoutes, useDispatchOpen, useRouteAnchors } from './route-context'

/** 折叠行：折起来的那部分做了什么、几次失败；点了展开收起 */
function FoldLine({
  part,
  open,
  onToggle,
  ids,
  stopped,
  sub,
}: {
  part: Pick<FoldPart, 'parts' | 'failed'>
  open: boolean
  onToggle: () => void
  /** 这一块的消息 id：搜索跳转要知道「目标在哪一段」（见 message-anchor） */
  ids?: string
  /** 对话停在这一段、又没说完：行尾弱化写「已停止」 */
  stopped?: boolean
  /** 总结后面的协调小行：比主折叠行再淡一点 */
  sub?: boolean
}) {
  return (
    <button
      data-fold-msgs={ids}
      data-fold={sub ? 'coord' : 'main'}
      onClick={onToggle}
      aria-expanded={open}
      title={open ? t('收起过程') : t('展开过程')}
      className="flex w-fit max-w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left text-xs text-subtle hover:text-muted"
    >
      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      <span className="truncate">{part.parts.join(' · ')}</span>
      {part.failed > 0 && <span className="shrink-0 text-danger">{t('{n} 次失败', { n: part.failed })}</span>}
      {stopped && <span className="shrink-0">· {t('已停止')}</span>}
    </button>
  )
}

/**
 * 一段完成的输出（一个节点、一轮对话）：干活的过程收进一行折叠，总结和结尾留在外面，和 Claude Code 一样；
 * 总结后面的派单、收尾动作和中间几句话另折一小行。要人看的（报错、提问、对话间消息）和还没办完的派单
 * 留在原位不折。执行中的那段照常流式显示，回复一完成就自动收起。摆法全在 foldLayout 里，这里只按结果画
 */
export function FoldedRun({
  msgs,
  task,
  teamNames,
  live,
  author,
  command,
  hideAuthor,
  stickyAuthor,
  running,
  foldId,
  stopped,
}: {
  msgs: TaskMessage[]
  task?: Task
  teamNames: Set<string>
  live?: boolean
  author?: Author
  /** 启动这些回复的命令 */
  command?: string[]
  /** 名字和模型由外面统一显示（对话一轮的吸顶署名） */
  hideAuthor?: boolean
  /** 展开时名字行吸顶（按 Agent 显示的对话） */
  stickyAuthor?: boolean
  /** 还在运行的工具、后台命令和子对话：放在这一段最后，不收进折叠 */
  running?: React.ReactNode
  /** 这一段在一轮里的标识（`轮 key#第几段`）：展开 / 收起的状态按它记，重新挂载、来新内容都不会被打回收起 */
  foldId?: string
  /** 对话停在这一段：没有总结时折叠行尾写「已停止」 */
  stopped?: boolean
}) {
  // AI 分析窗口里过程默认展开（设计稿把读取、搜索、运行一行行列出来，看得到它查了什么）；用户点过的照记下的来
  const ai = useAiLook()
  const [open, setOpen] = useState(() => (foldId ? segOpenOf(foldId, ai) : ai))
  const [midOpen, setMidOpen] = useState(false)
  const [tailOpen, setTailOpen] = useState(false)
  // 折叠段的 id 列表：长对话里每 200ms 拼一次上千个 id 会拖慢渲染（实测），按内容签名缓存，
  // 流式输出时末尾消息还是同一条，签名不变就沿用上次的字符串
  const foldIds = useRef({ key: '', value: '' })
  const orphan = useRouteAnchors()
  const isOpen = useDispatchOpen()
  const { agents } = useData()
  const { modelOf } = useAgentView()
  const effortOf = useEffortOf()
  const same = { task, teamNames, author, command }
  const all = <Msgs msgs={msgs} {...same} live={live} hideAuthor={hideAuthor} stickyAuthor={stickyAuthor} />
  // 子对话、子任务做完了也不折（staysOut）；没有派单上下文的地方（工作流节点、设计页）照旧都折
  const layout = live ? undefined : foldLayout(msgs, isOpen && ((d) => staysOut(d, isOpen)))
  // 没有可折的过程：整段照常显示，还在运行的东西接在后面
  if (!layout || layout.flat || (!layout.main.parts.length && !layout.mid.show && !layout.tail.show))
    return (
      <>
        {all}
        {running}
      </>
    )
  const { summary, ending, main, mid, tail } = layout
  const idsKey = `${msgs.length}|${msgs[0]?.id ?? ''}|${msgs[msgs.length - 1]?.id ?? ''}`
  if (foldIds.current.key !== idsKey) foldIds.current = { key: idsKey, value: msgs.map((m) => m.id).join(' ') }
  const ids = foldIds.current.value
  const toggle = () => setOpen(foldId ? toggleSegOpen(foldId, ai) : !open)
  const mainLine = main.parts.length ? (
    <FoldLine part={main} open={open} onToggle={toggle} ids={ids} stopped={stopped && summary < 0} />
  ) : undefined
  // 折叠开关每次都是新画的元素：给内容算个签名，内容没变时整段回复不重画
  const toggleKey = `${main.parts.join('·')}|${main.failed}|${open ? 1 : 0}|${stopped ? 1 : 0}`
  if (open)
    return (
      // 展开后开关仍然放在第一条回复的名字下面，不跑到名字上方；
      // 回复是从子任务、面板结果开始的，开关放在最前面，不夹在过程中间
      <Msgs
        msgs={msgs}
        {...same}
        slot={msgs[0].role === 'agent' ? mainLine : undefined}
        slotKey={toggleKey}
        lead={msgs[0].role === 'agent' ? undefined : mainLine}
        tail={running}
        hideAuthor={hideAuthor}
        stickyAuthor={stickyAuthor}
      />
    )
  // 留在外面的：要人看的消息、对不上派单的旧分诊、还没办完的派单（按原来的顺序）
  const kept = (list: TaskMessage[]) =>
    list.map((m) => {
      const own =
        m.role === 'agent' ? m.tools.flatMap((x, k) => (layout.open.has(dispatchKey(m.id, k)) ? [k] : [])) : []
      const spawned = layout.open.has(dispatchKey(m.id, -1))
      if (!keptOut(m) && !orphan.has(m.id) && !own.length && !spawned) return null
      return (
        <Fragment key={m.id}>
          {keptOut(m) &&
            (inlineEntry(m, task, teamNames) ?? (m.role === 'system' && <NoteMessage m={m} msgs={msgs} task={task} />))}
          {(own.length > 0 || spawned) && (
            <div className="proc-list flex flex-col">
              {spawned && <DispatchSlot msgId={m.id} tool={-1} />}
              {own.map((k) => (
                <DispatchSlot key={k} msgId={m.id} tool={k} fallback={<ToolRow tool={m.tools[k]} task={task} />} />
              ))}
            </div>
          )}
          <InlineRoutes msgId={m.id} />
        </Fragment>
      )
    })
  // 协调小行：点开就地列出那几条（结尾那条只列它的工具，文字在外面已经有了）
  const coord = (part: FoldPart, isOpenNow: boolean, flip: () => void, cut: number) =>
    part.show && (
      <div className="flex min-w-0 flex-col gap-2">
        <FoldLine part={part} open={isOpenNow} onToggle={flip} sub />
        {isOpenNow && (
          <Msgs
            msgs={part.msgs.map((m, i) => (i === cut ? { ...m, text: '' } : m))}
            {...same}
            hideAuthor
            compactFirst
          />
        )}
      </div>
    )
  // 名字行要吸顶时和展开时一样放在整段外面（理由见 Msgs）
  const head = summary >= 0 ? msgs[summary] : msgs.find((m) => m.role === 'agent')
  const sticky = !author && stickyAuthor && head && agents.find((x) => x.id === head.agentId)
  return (
    <>
      {sticky && (
        <StickyAuthor
          author={{
            name: sticky.name,
            cli: sticky.cli,
            icon: sticky.icon,
            model: modelOf(sticky),
            effort: effortOf(sticky),
            command,
          }}
        />
      )}
      {kept(main.msgs)}
      {head && (
        <AgentMessage
          // 没有总结（干完活一句话都没说）：只画名字和折叠行
          m={summary >= 0 ? head : { ...head, text: '', thinking: '', tools: [] }}
          {...same}
          hideProcess
          hideAuthor={hideAuthor || !!sticky}
          slot={mainLine}
          slotKey={toggleKey}
        />
      )}
      {kept(mid.msgs)}
      {coord(mid, midOpen, () => setMidOpen(!midOpen), mid.msgs.length - 1)}
      {ending >= 0 && <AgentMessage m={msgs[ending]} {...same} hideProcess compact />}
      {kept(tail.msgs)}
      {coord(tail, tailOpen, () => setTailOpen(!tailOpen), -1)}
      {running}
    </>
  )
}

/**
 * 通用对话里的一轮回复（工作流以外的 AI 对话都用它）：思考、工具调用和说明按发生的顺序流式显示，
 * 传了 fold 时回复完成后收进一个折叠（项目对话、UI 设计的 AI 对话都传）；完成后下面是时间、复制和各个对话自己的操作
 */
export function ChatReply({
  msgs,
  task,
  teamNames,
  live,
  author,
  command,
  hoistSticky,
  actions,
  last,
  latest,
  fold,
  children,
}: {
  msgs: TaskMessage[]
  task?: Task
  teamNames: Set<string>
  live?: boolean
  /**
   * 回复完成后思考、工具调用和中间的说明收进一个折叠，和 Claude Code 一样（项目对话、UI 设计的 AI 对话都用）。
   * 不传时整轮过程一路平铺，只给不想折叠的调用方用
   */
  fold?: boolean
  author?: Author
  /** 启动这一轮的命令：按 Agent 显示的对话没有 author，用这个显示在名字那行最右边 */
  command?: string[]
  /**
   * 吸顶署名交给外层（消息列表）渲染到回复体外面：放在 reply-body 里时粘性包含块只有这一段回复的高度，
   * 滚过回复后面的用户消息就断开了；TaskView 会把一轮回复和后面的用户消息放进同一个容器
   */
  hoistSticky?: boolean
  actions?: React.ReactNode
  /** 最后一轮：操作一直显示 */
  last?: boolean
  /**
   * 对话里的最新一轮（和父对话自己在不在跑无关）：
   * 运行区的子对话按它列。以前直接用 last，而 last 含「父对话没在跑」，
   * 于是父对话自己在跑时运行区整段不渲染，子对话一条也列不出来。
   */
  latest?: boolean
  /** 回复下面、时间上面的内容（例如需要的图片、AI 问的问题） */
  children?: React.ReactNode
}) {
  // 外层负责吸顶署名时，这里算好是谁：和 Msgs 里那套判定一致（这一段里第一条回复的 Agent）
  const { agents } = useData()
  const { modelOf } = useAgentView()
  const effortOf = useEffortOf()
  // 旧数据里同一个子对话的同一份汇报被写了两遍：这一轮显示前先收成一条（见 peer-dedupe）
  const list = dedupePeerReports(msgs)
  // 这一轮收尾时折到第几条消息：之后子对话的回报、后台命令结果又进来、CLI 被重新拉起来时，
  // 前面那段保持折叠，新过程接在它的最后一条回复后面继续显示，不把整轮重新铺开
  const key = list[0]?.id ?? ''
  const [cuts, setCuts] = useState<number[]>(() => foldCuts(key))
  useEffect(() => {
    // 不是执行中就记下收尾位置：第一次画出来就已经收尾（刷新、切回页签、被下面的计划卡片挤成非最后一段）
    // 也要记，否则之后子对话回报把它重新拉起来接着输出时，前面这段会被当成执行中整段铺开。
    // 记录不会重复：位置没往前走时 addFoldCut 返回原来的数组
    if (live) return
    setCuts(addFoldCut(key, list.length))
  }, [key, live, list.length])

  // 一段已经收尾、又有新内容进来时分成几段：前面的段始终折叠，只有最后一段跟着 live 走
  const parts = fold ? splitFolds(list, cuts) : [list]
  // 运行区（子对话、子任务、后台命令、工作流运行）挂在最新一段的总结下面；
  // 结果推回来开了新的一段，就跟着挂到新的总结下面
  const lastPart = lastIndex(parts, (p) => p.length > 0)
  // 吸顶头放在回复体外面时由 ChatReply 渲染，名字还是要和 Msgs 里一样取这一段第一条回复的 Agent
  const firstAgent = hoistSticky ? parts[0]?.find((m) => m.role === 'agent') : undefined
  const firstAgentDef = firstAgent ? agents.find((x) => x.id === firstAgent.agentId) : undefined
  const hoistedAuthor: Author | undefined = hoistSticky
    ? (author ??
      (firstAgentDef
        ? {
            name: firstAgentDef.name,
            cli: firstAgentDef.cli,
            icon: firstAgentDef.icon,
            model: modelOf(firstAgentDef),
            effort: effortOf(firstAgentDef),
            command,
          }
        : undefined))
    : undefined
  const body = (
    <>
      {author && !hoistSticky && <StickyAuthor author={author} />}
      {/* 回复完成后思考、工具调用和中间的说明自动收进一个折叠，折叠行写这段做了什么 */}
      {parts.map((part, i) => {
        if (!part.length) return null
        const tail = i === parts.length - 1
        // 名字只在第一段显示一次，后面几段接着上面那段接着写；
        // 按 Agent 显示的对话没有外面的署名栏，名字行自己吸顶，和按 CLI 显示的一样
        // 吸顶头由外层渲染时，这一段的正文不再自己画名字行
        const same = { msgs: part, task, teamNames, author, command, hideAuthor: !!author || hoistSticky || i > 0 }
        if (!fold) return <Msgs key={i} {...same} live={live} stickyAuthor={!author && !hoistSticky} />
        const isLive = !!live && tail
        const isTail = i === lastPart
        // 子对话和后台命令只在最新的一轮上列。两者都跟 latest 走：latest 已经跳过尾部刚发出的
        // 用户消息（见 latest-turn），发送的一瞬间它们不会整块消失；以前后台命令在对话停着时
        // 看 last（「最后一段」），尾部多了用户消息就会和子对话分叉，两行一起闪一下
        const kids = !!latest && isTail
        const jobs = kids
        // 运行区放在这一段的总结下面（它自己判空：没东西时连分割线也不画）。
        // 不是最新的一段也可能有没收尾的工具（子对话回报把它顶下去了），那些工具仍归它自己列；
        // 子对话、后台命令、工作流运行只在最新的一段列，旧段不重复
        const footer = (
          <RunningFooter
            task={task}
            msgs={msgs}
            live={isLive}
            tools={runningTools(part)}
            jobs={jobs}
            kids={kids}
            last={last}
            latest={latest}
            isTail={isTail}
          />
        )
        // 整个对话改了哪些文件：只在对话停下来以后、挂在最后一轮的最后一段下面（用户要的是整个对话的，
        // 不是每一轮总结下面各一张）；对话还在跑时不出，跑完才出
        const convCard = task && !isLive && last && isTail && !task.working
        return (
          <FoldedRun
            key={i}
            {...same}
            live={isLive}
            foldId={`${key}#${i}`}
            // 对话停下了、这一段又没说完：折叠行尾写「已停止」
            stopped={!!task && !!last && isTail && !task.working && task.status === 'stopped'}
            stickyAuthor={!author && !hoistSticky && i === 0}
            running={
              convCard ? (
                <>
                  <ConvChangesCard task={task!} />
                  {footer}
                </>
              ) : (
                footer
              )
            }
          />
        )
      })}
      {children}
    </>
  )
  // 正文比回复头缩进一格（reply-body）：图标在最左，名字、正文、下面的复制按钮在同一条竖线上
  // 吸顶头要跨过后面的用户消息时放在回复体外面（hoistSticky），由 TaskView 的分组容器当粘性包含块
  if (live)
    return (
      <>
        {hoistedAuthor && <StickyAuthor author={hoistedAuthor} />}
        <div className="reply-body flex flex-col gap-2">{body}</div>
      </>
    )
  const replies = list.map(replyText).filter((x, i) => list[i].role === 'agent' && x.trim())
  const text = replies.map((x) => x.trim()).join('\n\n')
  // 朗读只念没折叠的部分：每一段收尾后留在外面的总结；不折叠的对话整轮都在外面，念全部
  const spoken = fold ? parts.map(unfoldedText).filter(Boolean).join('\n\n') : text
  return (
    <>
      {hoistedAuthor && <StickyAuthor author={hoistedAuthor} />}
      <ReplyFrame text={text} at={list.at(-1)?.at} actions={actions} always={last} speak={{ id: key, text: spoken }}>
        <div className="reply-body flex flex-col gap-2">{body}</div>
      </ReplyFrame>
    </>
  )
}
