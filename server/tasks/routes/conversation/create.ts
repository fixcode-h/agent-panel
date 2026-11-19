import { Hono } from 'hono'
import { tasksContract } from '../../../../shared/api-contract/tasks.ts'
import { sourceHeader } from '../../../../shared/peer-message.ts'
import { randomUUID } from 'node:crypto'
import { FlowRun } from '../../../../shared/tasks/flow-schema.ts'
import { z } from 'zod'
import { NewTaskInput, Task, type Workflow } from '../../../../shared/schema.ts'
import { taskSnapshot } from '../../../../shared/builtin/default.ts'
import { exposeSlots } from '../../../../shared/expose.ts'
import { newTask, withAttachments } from '../../../../shared/task.ts'
import { chatMissingParams } from '../../../../shared/agents/role.ts'
import { CHILD_ASK_DEFAULT, childAskInitial } from '../../../../shared/children/ask.ts'
import { createWorktree } from '../../../exec/worktree.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'
import { scopeError } from '../../../../shared/conv-mode.ts'
import { BUG_CMD } from '../../../../shared/builtin/bug-method.ts'
import { bugInPlace } from '../../../../shared/bug/in-place.ts'
import { currentTask } from '../../read.ts'

/**
 * 建一个顶层对话并开始执行。界面上的 POST /tasks 和面板自己发起的（定时计划）共用这一条链路：
 * 校验项目和角色、按项目建独立分支、拷附件、启动执行。
 * 失败时返回原因和状态码，不抛错：定时器要把原因记到计划里给用户看。
 */
export async function createTask(
  s: TasksScope,
  input: NewTaskInput,
  raw: unknown,
): Promise<{ task: Task } | { error: string; status: 400 | 404 | 409 }> {
  // 没有项目的是 Chat 模式的聊天，只能直接对话
  if (!input.projectId && input.mode === 'workflow') return { error: t('缺少项目'), status: 400 }
  const project = input.projectId ? await s.deps.projects.get(input.projectId) : s.chatProject('')
  if (!project) return { error: t('项目不存在'), status: 404 }
  const agents = await s.deps.agents.list()
  // 子对话：挂在父对话下，固定用任务 Agent，不能再建下一层
  let parent: Task | undefined
  if (input.parentTaskId) {
    parent = (await s.store.get(input.parentTaskId)) ?? undefined
    if (!parent) return { error: t('父对话不存在'), status: 404 }
    if (parent.parentTaskId) return { error: t('子对话不能再创建子对话'), status: 400 }
    if (parent.projectId !== input.projectId) return { error: t('子对话必须和父对话在同一个项目'), status: 400 }
    input.mode = 'chat'
    input.rootTaskId = parent.rootTaskId || parent.id
    // 新建子对话的「提问」初始值跟着父对话的「子对话也提问」走（父对话关掉提问只管已经建好的，不管之后的）
    input.askUser = childAskInitial(parent)
  }
  // 顶层对话（父对话、普通会话）：之后新建的子对话默认开着提问（设置里不再有这一项，用户 2026-10-31 定的）；右键菜单改过的以父对话上的为准
  if (!parent) input.childAskUser = input.childAskUser ?? CHILD_ASK_DEFAULT
  let workflow: Workflow | undefined
  if (input.mode === 'workflow') {
    workflow = input.workflowId
      ? ((await s.deps.workflows.get(input.workflowId)) ?? undefined)
      : await s.projectWorkflow(project)
    if (!workflow) return { error: t('项目还没有指定工作流，请选择一个工作流或改用直接对话'), status: 400 }
  } else {
    // 旧界面不传 agentId 时跟着项目的默认对话 Agent；传了空字符串表示不用 Agent 角色
    if (!(raw && typeof raw === 'object' && 'agentId' in raw) && project.defaultAgentId)
      input.agentId = project.defaultAgentId
    if (input.agentId && !agents.some((a) => a.id === input.agentId))
      return { error: t('请选择对话的角色'), status: 400 }
    // 角色分两类，各自只在对应模式里用（ADR 0038）：Chat 页只用 Chat 角色，项目里只用 Agent 角色
    const wrongScope = scopeError(
      input,
      agents.find((a) => a.id === input.agentId),
    )
    if (wrongScope) return { error: wrongScope, status: 400 }
  }
  const lack = chatMissingParams(input, agents)
  if (lack) return { error: lack, status: 400 }
  const params = workflow ? s.paramsOf(project, workflow.id) : {}
  await s.refreshAgents()
  const snapshot = workflow ? taskSnapshot(workflow, await s.deps.workflows.list(), params, s.testOpts(project)) : []
  const draft = {
    ...newTask(
      input,
      workflow,
      new Date().toISOString(),
      randomUUID(),
      snapshot,
      workflow ? exposeSlots(workflow, params) : {},
    ),
    id: randomUUID(),
    testSteps: workflow ? project.testSteps : [],
    platform: workflow ? process.platform : '',
    // 直接经接口建的工作流任务（端到端测试、脚本）：一次没有父对话的独立运行，在项目目录里跑完直接完成。
    // 界面上的工作流都由父对话 start_workflow 起（见 server/tasks/flow-runs.ts）
    ...(workflow &&
      input.mode === 'workflow' && {
        flowRun: FlowRun.parse({ owner: '', workflowName: workflow.name, kind: 'readonly', input: input.prompt }),
      }),
  }
  // 这里是顶层对话选的独立分支（子对话由项目设置决定）：只看输入框的「独立分支」按钮，不看角色。
  // 勾了就在创建时建好（用户要求），父对话也一样，它的子对话从这个分支开出、合回这里
  if (input.isolate && !parent && input.projectId) {
    try {
      draft.worktree = await createWorktree(project.path, draft.id, draft.title)
    } catch (e) {
      return { error: (e as Error).message, status: 400 }
    }
  }
  // 工作流的第一条要求也能用「/命令」：展开后交给各节点，对话里仍显示输入的原文
  const raw0 = await s.expandForWorkflow(draft, input.prompt)
  // 别的对话替它建的（app 动作 task.create）：第一条记成「同项目对话发来」，交给 CLI 时写明不是用户说的（ADR 0041）
  const sender = input.from && !parent ? await currentTask(s, input.from) : undefined
  const first = draft.messages[0]
  if (sender && first) first.peer = await s.peerOf(sender, 'peer', 'task', input.prompt)
  const head = first ? sourceHeader(first) : ''
  const expanded = head ? head + (raw0 || input.prompt) : raw0
  if (expanded && first) first.prompt = expanded
  // 附件：图片拷进这个对话的对话目录（tasks/files/<id>/attachments/），交给 Agent 的是那里的绝对路径；
  // 其它文件原样用绝对路径。对话里显示的仍是原来那份（缩略图从附件目录读）
  const placed = await s.placeInTask(draft, input.attachments ?? [])
  // 第一句就是 /bug 的普通对话：建好就是用户报的 Bug，第一轮就有 submit_diagnosis（分析稿 B10）
  if (!parent && !sender && BUG_CMD.test(input.prompt.trim()) && bugInPlace(draft, agents))
    draft.bug = { kind: 'report' }
  const task = await s.store.create(draft)
  return {
    task: await s.start(s.reserve(task).value, withAttachments(expanded || input.prompt, placed), true, agents),
  }
}

/** POST /tasks：界面上新建对话 */
export function createRoute(s: TasksScope): Hono {
  const app = new Hono()
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null)
    const p = tasksContract.create.body.safeParse(body)
    if (!p.success) return s.bad(c, z.prettifyError(p.error))
    const res = await createTask(s, p.data, body)
    if ('error' in res) return s.bad(c, res.error, res.status)
    return c.json(res.task, 201)
  })
  return app
}
