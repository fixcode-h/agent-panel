import { callSubmitTool, submitTools } from './submit-tools.ts'
import { docsFirstArgs, docsFirstFields } from './docs-first-tool.ts'
import {
  agentField,
  briefOf,
  tierField,
  resumeField,
  batchField,
  SPAWN_TOP_FIELDS,
  paramsField,
  routeField,
  routeOf,
  tasksField,
  stepField,
  planItem,
} from './orch-fields.ts'
import { shellNote } from '../shared/shells.ts'
import { lastShell } from './shells.ts'
import { askOptions } from '../shared/task.ts'
import { HANDOFF_FIELDS, handoffInput } from '../shared/handoff.ts'
import { overrideInput, triageInput } from '../shared/review-gate.ts'
import type { HelperReport, HelperSpec, Orchestra } from '../shared/engine.ts'
import { INLINE_EDIT_MAX_FILES, INLINE_EDIT_MAX_LINES } from '../shared/inline-edit.ts'
import { ASK_PUSH_TOOL, callAskPush } from './ask-push.ts'
import { callStartWorkflow } from './start-workflow-tool.ts'
import { BUG_CASE_TOOL, callBugCase, callDiagnosis, DIAGNOSIS_TOOL } from './diagnosis-tool.ts'
// 用法说明搬到了单独的文件（这个文件到了行数上限），调用方照旧从这里取
export { orchHint } from './orch-hint.ts'

/**
 * 编排工具：工作流节点和对话每次调用 CLI 时，绑定在调用它的节点上（执行引擎的 Orchestra）。
 * 节点用它派子 Agent 并行处理、取回结果、查各 Agent 的状态、向主 Agent 提问、给别的 Agent 传话；
 * 项目对话用它分派子对话，子对话用它和父对话通讯、认领文件。
 * 它和提问、等下一句这些工具挂在同一个面板 MCP（ask-mcp.ts 的 panel）上：一次调用只连一个面板服务。
 * 工具调用不能等太久（Codex 老版本默认 60 秒超时），等待都有上限；wait_agents 例外，见 WAIT_AGENTS_S
 */

const DEFAULT_WAIT_S = 40
// wait_agents 等到子任务全部结束或有人传话才回（每回一次 CLI 就带整份上下文再请求一次），这是兜底上限：
// 要短于 CLI 一次工具调用的超时（Codex 的 tool_timeout_sec 在定义里放宽到 1 小时），等待期间写 SSE 心跳（ask-mcp.ts）
export const WAIT_AGENTS_S = 1500

/** 后台命令在哪个 shell 里跑（设置里的命令行环境），Agent 按它的语法写命令 */
const shellHint = () => {
  const sh = lastShell()
  return sh ? shellNote(sh) : ''
}

/** 按能力给工具（ADR 0038）：team 管查状态和传话，canSpawn 管派子任务，其余按各自的能力和宿主的客观条件 */
export function orchTools(o: Orchestra) {
  const main = o.self.endsWith('@main')
  return [
    ...(o.team
      ? [
          {
            name: 'get_status',
            title: '查看节点状态',
            description:
              '查看这次运行里各节点和派出的子 Agent 的状态、结果摘要，按层级缩进。传话、等结果前先用它找节点 id。',
            inputSchema: { type: 'object', properties: {} },
          },
        ]
      : []),
    ...(o.canBeginEdit
      ? [
          {
            name: 'begin_edit',
            title: '开独立分支',
            description:
              '确定要改文件时先调用：面板从当前目录开一个独立分支。成功后用一两句写下查到的情况和打算怎么改，然后马上结束这一轮，面板会切到独立分支的目录里接着做。调用前不要改任何文件。',
            inputSchema: { type: 'object', properties: {} },
          },
        ]
      : []),
    ...(o.canBackground
      ? [
          {
            name: 'run_background',
            title: '后台命令',
            description:
              '把要跑很久的命令（完整测试、编译、打包）交给面板在后台跑，马上返回编号，不用干等；跑完结果会自动推回给你。等待期间不要改这条命令要检查的文件。' +
              // 子任务的结果推回的是派它的对话（它自己已结束），要让模型知道这件事，不要以为能在这里等结果
              (o.helper
                ? '你是子任务：结果推回派你的对话，并标注是哪个子任务起的，你启动后接着做别的事或结束这一轮。'
                : '') +
              shellHint(),
            inputSchema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: '要执行的命令原文' },
                name: { type: 'string', description: '给这条命令起个短名字，例如「端到端测试」' },
                cwd: { type: 'string', description: '相对当前目录的工作目录，不写就是当前目录' },
                exclusive: {
                  type: 'boolean',
                  description: '编译、打包这类会抢文件锁的命令设为 true：按项目排队，同一时间只跑一个',
                },
                timeout_minutes: {
                  type: 'number',
                  description:
                    '最多跑多少分钟，到点面板停掉它并把结果推回；按命令正常要多久写宽一些，不写默认 120，最多 480',
                },
                ...(o.plans ? { step: stepField('这条命令') } : {}),
              },
              required: ['command'],
            },
          },
          {
            name: 'check_background',
            title: '查看后台命令',
            description:
              '查后台命令的状态、已经跑了多久、多久没输出和最近的输出；不写 id 列出这个对话的全部。结果会自动推回来，不需要轮询。',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          },
          {
            name: 'stop_background',
            title: '停止后台命令',
            description: '停掉这个对话的一条后台命令：确认它卡住了（长时间没输出、跑偏了）才用，停掉后查清原因再重跑。',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          },
        ]
      : []),
    ...(o.plans
      ? [
          {
            name: 'set_plan',
            title: '更新计划',
            description:
              '列出或更新这个对话的执行计划，每次交整份列表（已有的步骤带 id）。最多两层：主步骤和子步骤。一份计划里同时只能有一个步骤是「进行中」（同一层）；跑长命令、派子对话前用带 step 的参数把它变成等待中。同一件事的细化 / 插一步 / 调顺序用 partial 只交变更项；目标变了（换方向、大部分步骤作废）先 finish_plan 结束这份计划、再带新 title 开新的，不要在同一份里大换血。步骤一多（10 条以上）就分两批交：一批带 partial: true 只写要变的步骤，没写到的步骤留在计划里不动，免得一次拼一大段 JSON 拼错。完成的步骤不能再改，同样的内容要再做就新加一步；步骤全部完成后这份计划就结束，之后的新内容直接开新计划。新开计划、整份提交时返回合并后的计划和每一步的 id；partial 只返回变了的步骤（新步骤带 id）和进度、下一步，完整计划每轮提示里都有。',
            inputSchema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '这份计划的名字（开新计划时写）' },
                summary: {
                  type: 'string',
                  description:
                    '把最后几步标完成、计划随之结束时一起交：这份计划的总结（做了什么、结果、遗留），记在你自己的计划上',
                },
                partial: {
                  type: 'boolean',
                  description:
                    '只交变更步骤：为 true 时没写到的步骤留在计划里不动（不删、不重新计数）；新加的步骤照常追加。默认 false：没写到的未完成步骤算删掉',
                },
                steps: {
                  type: 'array',
                  description: '主步骤，按执行顺序',
                  items: {
                    ...planItem,
                    properties: {
                      ...planItem.properties,
                      children: { type: 'array', description: '子步骤（只能一层）', items: planItem },
                    },
                  },
                },
              },
              required: ['steps'],
            },
          },
          {
            name: 'finish_plan',
            title: '结束计划',
            description:
              '主动结束这份计划（步骤全部完成时计划本来就会自动结束）。summary 写这份计划的总结（做了什么、结果、遗留），记在你自己的计划上；之后有新内容用 set_plan 开新计划。',
            inputSchema: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string',
                  description: '这份计划的总结：做了什么、结果、遗留；父对话和用户读它了解你做完了什么',
                },
              },
            },
          },
        ]
      : []),
    ...(o.planning
      ? [
          {
            name: 'start_workflow',
            title: '启动工作流',
            description:
              '在你下面开一个工作流子对话，按工作流的流程图把这件事做完（异步执行，马上返回子对话 id）。流程图跑完由它的执行角色评审、测试、合回，你按等子对话的方式等它。只用于步骤和门禁事先定好的事，判定规则见提示里的「可用工作流」；问答、排查、Bug 定位、小改动不要起工作流。',
            inputSchema: {
              type: 'object',
              properties: {
                workflow: {
                  type: 'string',
                  description: '工作流 id 或名字（见提示里的「可用工作流」）；不写用项目默认工作流',
                },
                input: { type: 'string', description: '这次要做什么：目标、范围、验收标准，工作流的节点只看得到这些' },
                title: { type: 'string', description: '子对话的短标题（10–20 字），不写用工作流名字加要做的事' },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '这个工作流负责的文件或目录（相对项目根），和 create_conversation 的 files 一样',
                },
                again: {
                  type: 'string',
                  description: '已有工作流子对话的 id：在它的分支上把同一个工作流再跑一次（方案被否、要从头再来时用）',
                },
                route: routeField(),
                ...(o.plans ? { step: stepField('这个工作流') } : {}),
              },
              required: ['input'],
            },
          },
        ]
      : []),
    ...(o.planner && !o.planning
      ? [
          {
            name: 'run_workflow',
            title: '启动工作流',
            description:
              '起一次新的工作流运行：节点全部新建，从开始节点按流程图顺序执行一遍（同一层没有依赖的节点同时执行）。这次运行走完就停下，不会自己再跑。你的会话保留，前面几轮的结论还在。',
            inputSchema: {
              type: 'object',
              properties: {
                input: { type: 'string', description: '这次运行要做什么：目标、范围、和上一轮的区别' },
              },
              required: ['input'],
            },
          },
          {
            name: 'close_run',
            title: '结束这次运行',
            description:
              '结束这次运行：还没执行的节点不再执行，之后的要求由你直接处理。用户说不用再走了、或者走不下去时用。',
            inputSchema: { type: 'object', properties: {} },
          },
        ]
      : []),
    ...(o.coordinator
      ? [
          {
            name: 'list_conversations',
            title: '查看子对话',
            description: '列出当前对话下的子对话：id、标题、状态和最近一条结果。分派前先用它确认有没有合适的子对话。',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'create_conversation',
            title: '新建子对话',
            description:
              '新建一个子对话并把这条需求交给它处理（异步执行，马上返回）。现有子对话都不相关、且需求需要改代码或做较大的研究时用。标题由你分析这条需求后起，不要照抄用户原话的开头几个字。子对话报错、失败或被中断要重试时不要新建：用 send_to_conversation 交回原来那个子对话，它在原来的会话里接着做。',
            inputSchema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: '你分析后起的短标题（10–20 字），点明要做的功能或问题，能和其他子对话区分开',
                },
                message: {
                  type: 'string',
                  description:
                    '完整的需求和背景，子对话只看得到这些：写清涉及的模块或目录、要交付什么、验收标准是什么；派「文档」时给出要记什么和依据在哪（提交号、文件路径、命令输出、关键结论）',
                },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    '这个子对话负责的文件或目录（相对项目根）：共用目录时面板替它认领，别的子对话要等它做完；独立分支时用来核对有没有和别的子对话改到同一个文件（两边改同一文件时 git 常常自动合并、不报冲突）',
                },
                role: {
                  type: 'string',
                  description: '子对话用哪个高级角色（名字）：不写用「执行」；项目里有更合适的（例如 UE 专用的）时写它',
                },
                kind: {
                  type: 'string',
                  enum: ['bug'],
                  description:
                    '用户报的 Bug 写 "bug"：子对话修之前先交诊断报告，用户确认了方案才改。评审、测试里发现的问题不写',
                },
                route: routeField(),
                ...docsFirstFields,
                ...(o.plans ? { step: stepField('这个子对话') } : {}),
              },
              required: ['title', 'message'],
            },
          },
          {
            name: 'send_to_conversation',
            title: '交给子对话',
            description:
              '把消息交给一个已有的子对话继续处理（异步执行）。它和这条消息相关时用，id 从 list_conversations 取；子对话失败或被中断后要重试也用它交回原来那个子对话，不要新建。一条消息只交给一个子对话：用户的一条消息（连同用户定下的规则）只挑关联最紧密的那一个交，同一段话不要再发给别的子对话（会被拒绝），也不要换个说法再发。',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '子对话 id' },
                message: { type: 'string', description: '要交给它的消息，写清楚和原任务的关系' },
                route: routeField(),
                ...(o.plans ? { step: stepField('这个子对话') } : {}),
              },
              required: ['id', 'message'],
            },
          },
          {
            name: 'stop_workflow',
            title: '终止工作流',
            description:
              '终止工作流子对话正在跑的流程图：方向错了、已经不需要、卡住不动时用。没跑的节点不再跑，子对话按失败交回，结果里写着这次运行改了哪些文件；之后要清理还是接着做，用 send_to_conversation 交给它。',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '工作流子对话的 id' },
                reason: { type: 'string', description: '为什么终止，一句话' },
              },
              required: ['id', 'reason'],
            },
          },
        ]
      : []),
    ...(o.inlineEdit
      ? [
          {
            name: 'begin_inline_edit',
            title: '开始就地改动',
            description: `父对话就地做一个微小改动前调用：改什么、改成什么已经清楚、不用排查，最多 ${INLINE_EDIT_MAX_FILES} 个文件、${INLINE_EDIT_MAX_LINES} 行以内（文案、配置值、一两行文档）。面板校验子对话有没有在合回、要改的文件有没有子对话在用；通过后你改文件、跑项目的快速检查、本地提交，再调用 end_inline_edit。Bug、要排查的、改公共接口或数据格式的都交给子对话，不走这里。`,
            inputSchema: {
              type: 'object',
              properties: {
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: `要改的文件（相对项目根），最多 ${INLINE_EDIT_MAX_FILES} 个；同一提交该带的（例如文案的英文翻译）也列上`,
                },
                reason: { type: 'string', description: '改什么、为什么能就地改' },
                route: routeField(),
              },
              required: ['files', 'reason'],
            },
          },
          {
            name: 'end_inline_edit',
            title: '结束就地改动',
            description:
              '就地改动改完、跑过快速检查并本地提交后调用：面板按真实改动核对文件数、行数和没声明的文件，越界会提示用户；然后恢复子对话的收尾。这一轮结束时没调用也会自动收。',
            inputSchema: { type: 'object', properties: {} },
          },
        ]
      : []),
    ...(o.capabilities
      ? [
          {
            name: 'use_capability',
            title: '加载能力',
            description:
              '就地用你挂载的某个能力前调用：取它的完整做法、参数和要用的 Skill，再在当前对话里按它做。只能派出的能力（例如评审）会被拒绝并告诉你怎么派。能力列表见角色设定里「你挂载的能力」。',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '能力的名字，例如「测试验收」' },
                params: {
                  type: 'object',
                  description: '这次用的参数取值（可选），例如 {"scope": "快速"}；不写按挂载上的取值',
                },
              },
              required: ['name'],
            },
          },
        ]
      : []),
    ...(o.ueBuild === 'parent'
      ? [
          {
            name: 'request_build',
            title: '申请编译',
            description:
              'UE 项目：收到子对话的编译申请或用户要求时，向面板申请编译（跑项目测试步骤里的编译）。编译是占位的资源：同一编译目录同一时间只编译一次，别的父对话占着时排在后面，面板会告诉你是谁、也告诉对方你在等。马上返回，结果推回给你，也推给 children 里的子对话。',
            inputSchema: {
              type: 'object',
              properties: {
                note: { type: 'string', description: '为什么编译：哪些子对话申请的、包含哪些改动' },
                children: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '申请这次编译的子对话 id：编译结果面板会直接推给它们（不用你转述）',
                },
                ...(o.plans ? { step: stepField('这次编译') } : {}),
              },
              required: ['note'],
            },
          },
        ]
      : []),
    ...(o.peers
      ? [
          {
            name: 'list_peers',
            title: '查看其他父对话',
            description: '列出同一项目里的其他父对话：id、标题、状态、是否占着编译。要和它们协调前先用它。',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'message_peer',
            title: '给其他父对话传话',
            description:
              '给同一项目里的另一个父对话传话（例如你在等它的编译、要改它也在改的公共文件）：它正在执行就实时送达，空闲就放进它的收件箱，下一轮处理。只协调，不替它做决定。',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '父对话 id（list_peers 里有）' },
                text: { type: 'string', description: '要告诉它的事，写清背景和你希望它怎么配合' },
              },
              required: ['id', 'text'],
            },
          },
        ]
      : []),
    ...(o.parentOf
      ? [
          {
            name: 'finish_child',
            title: '收尾子对话',
            description:
              '子对话请你收尾（消息里写着「收尾请求」）时调用：面板把它的独立分支合回你所在的分支、把它计划里的收尾步骤标完成、结束它并删除独立分支和分支，你计划里等它的那一步也标完成。合并就是验收：先看它交的验证结果，不够就别收，用 send_to_conversation 交回要补的。合不进去（冲突）会自动退回给它处理。项目里有范围为「全量，合并后由父对话跑」的测试步骤时，合回后面板自动在你的目录里按顺序跑它们（结果和耗时直接回传子对话，你不用自己跑）：通过才结束它，失败会退回给它修。',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '子对话 id（收尾请求里有，或者从 list_conversations 取）' },
              },
              required: ['id'],
            },
          },
        ]
      : []),
    ...(o.child
      ? [
          {
            name: 'message_parent',
            title: '回报父对话',
            description:
              '给父对话发消息。需要父对话决定或动手（协调、拍板）时 question 设为 true，马上交给它；只是汇报阶段进展时不设，面板记下来，这一轮结束时和你的状态合成一封交给父对话（一轮只交一封，不叫醒它）。你不能直接联系其他子对话，需要配合都经过父对话。',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '要告诉父对话的内容，写清背景和你的建议' },
                question: { type: 'boolean', description: '需要父对话（或用户）决定时为 true' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'question 为 true 时可选的几种做法（2–4 个，每个一句话），用户可以直接点选',
                },
                ...(o.plans
                  ? {
                      wait_fix: {
                        type: 'string',
                        description:
                          '编译 / 测试报错不是你改出来的、要父对话安排别的子对话修时，写被它卡住的计划步骤 id：面板把这一步标成等父对话通知，你接着做计划里别的步骤，不要停下干等；text 里写清报错原文、出错的文件和为什么判断不是你改的',
                      },
                    }
                  : {}),
              },
              required: ['text'],
            },
          },
          {
            name: 'suggest_next_step',
            title: '收尾建议交给用户选',
            description:
              '这一轮做完、总结里要给用户「下一步怎么做」的建议时调用：把建议和 2–4 个可选做法交给用户选，选完会自动交回给你接着做。不要只把建议写在结论里——那样用户不知道你是在等他，还是已经结束了。子对话的完成标准是做完收尾（合回父对话所在的分支，P4 是按文件类型分好 changelist；面板自动列成计划的最后一步，不用写成建议）：计划和建议里都不要写推送 / 等推送 / 同步远端 / 其他分支，这类操作（推送、创建 PR、P4 submit、合并到主干）由父对话决定：remote 必须写 none，写其它值会被拒绝、卡片不会交给用户。',
            inputSchema: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: '给用户的建议：建议接着做什么，一句话说清理由',
                },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    '2–4 个可选做法（每个一句话），第一个是推荐做法并在末尾标「（推荐）」；不给时用「按建议继续」「先不做，先停在这」',
                },
                remote: {
                  type: 'string',
                  enum: ['none', 'push', 'pr', 'submit', 'merge-main'],
                  description:
                    '这些建议会不会改远端：只做本地动作写 none；推送 → push、创建 PR → pr、P4 submit → submit、合并到主干 → merge-main。后四种不在子对话的处理范围，写了会被拒绝。不改远端也必须写 none（不能省）。',
                },
              },
              required: ['text', 'remote'],
            },
          },
          ...(o.canSubmit
            ? [
                {
                  name: 'submit_merge',
                  title: '请父对话收尾',
                  description: o.isolated
                    ? '只剩合回时调用：计划其余步骤都做完、后台命令都结束、没有待回答的提问、编译测试在你的独立分支里跑通。面板把你现在的改动提交到你的分支，请父对话收尾：父对话把它合回原分支（合并就是验收）、把计划最后的收尾步骤标完成、结束这个子对话并删除独立分支。项目里有范围为「全量，合并后由父对话跑」的步骤时，合回后由父对话跑它们：通过才标完成、删分支，失败会把报错推回来，修好再调用一次（这些步骤会全部重跑）。完成只是「已合回父对话所在的分支」，不涉及推送。还有没做完的会直接拒绝并说明还差什么；合不进去（冲突）会退回给你。马上返回，调用后结束这一轮。'
                    : '只剩收尾时调用：计划其余步骤都做完（P4 已按类型分好 changelist）、后台命令都结束、没有待回答的提问、改了代码的已经评审并处置、编译测试跑通。你和父对话共用目录（P4、没有版本管理或项目设成共用目录），改动已经在原目录里，面板不提交也不合并，只请父对话验收：父对话收下后面板把计划最后的收尾步骤标完成、结束这个子对话。评审、测试、交接要点的校验和独立分支一样，不因为版本管理方式不同就省掉。还有没做完的会直接拒绝并说明还差什么；验收没过会退回给你。马上返回，调用后结束这一轮。',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      note: { type: 'string', description: '这次改了什么，一句话' },
                      tests: {
                        type: 'string',
                        description:
                          o.ueBuild === 'child'
                            ? '做了哪些不用编译的检查、结果如何，并写明「UE 编译已申请父对话」'
                            : `${o.isolated ? '在独立分支里' : ''}跑了哪些编译、测试，结果如何（例如「npm run typecheck、npm test 全部通过」）；只读排查没改文件时写明`,
                      },
                      ...(o.ueBuild === 'child' && o.isolated
                        ? {
                            build: {
                              type: 'boolean',
                              description:
                                'UE 项目：合回原分支后替你向父对话申请编译（默认 true）；没改 C++（只改 Lua、配置、表格、资源、文档）时写 false，面板也会按改动文件判断',
                            },
                          }
                        : {}),
                      handoff: {
                        type: 'object',
                        description:
                          '交接要点：以后父对话再把消息交给你、上下文又大时，新会话只带这份摘要（加上面板补的提交和改动文件），写清下次能直接找到代码和文档的信息',
                        properties: Object.fromEntries(
                          HANDOFF_FIELDS.map((f) => [f.key, { type: 'string', description: f.description }]),
                        ),
                        required: HANDOFF_FIELDS.filter((f) => f.required).map((f) => f.key),
                      },
                      review_triage: {
                        type: 'array',
                        description:
                          '最近一次评审列了高级或中级时必填：每条你自己核实之后的处置。评审的意见是线索不是结论，不要它说什么就改什么，也不要不核实就驳回；处置会连同收尾请求交给父对话',
                        items: {
                          type: 'object',
                          properties: {
                            id: {
                              type: 'string',
                              description: '评审意见的编号（R1、R2…）；评审没编号时写那条意见的原话摘要',
                            },
                            decision: {
                              type: 'string',
                              enum: ['fix', 'reject', 'defer'],
                              description:
                                'fix：核实是真问题、在这次范围里，已改并验证；reject：核实不成立；defer：真问题但范围外 / 只在构造的极端数据上成立 / 代价大于收益，这次不改、交接时列为已知问题',
                            },
                            reason: {
                              type: 'string',
                              description:
                                '怎么核实的（读了哪段代码、跑了什么）和结论：评审只看代码、不一定准，写你自己重新评估的结果；fix 写你定的改法和验证，reject 写反例或代码依据，defer 写影响面',
                            },
                          },
                          required: ['id', 'decision', 'reason'],
                        },
                      },
                      review_override: {
                        type: 'object',
                        description:
                          '显式放行：评审没过（没派过、没写结论、列了必须处置项）而用户明确要求「已知问题也合并」时才传。它是门禁的出口，不是提醒——面板把谁、什么时候、为什么、原本拦住什么记在任务上，收尾消息里带给父对话。不要自己判断「问题不大」就放行',
                        properties: {
                          by: {
                            type: 'string',
                            enum: ['user', 'parent'],
                            description: '谁放行的：用户本人要求写 user；父对话决定写 parent。执行角色自己不能放行',
                          },
                          reason: {
                            type: 'string',
                            description:
                              '为什么带着这个问题合并（至少 12 字）：问题的内容、用户为什么要求先合、后续什么时候补',
                          },
                        },
                        required: ['by', 'reason'],
                      },
                    },
                    required: ['tests', 'handoff'],
                  },
                },
              ]
            : []),
          // 有独立分支的走 submit_merge 的 build：改动要先合回父对话的目录才编得到
          ...(o.ueBuild === 'child' && !o.isolated
            ? [
                {
                  name: 'request_build',
                  title: '申请编译',
                  description:
                    'UE 项目：子对话不编译。改完、做完不用编译的检查后调用，向父对话申请编译；父对话按申请向面板占位编译，结果由父对话转给你。马上返回。',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      note: { type: 'string', description: '改了哪些模块和文件、需要编哪个目标、做过哪些检查' },
                    },
                    required: ['note'],
                  },
                },
              ]
            : []),
          ...(o.claims
            ? [
                {
                  name: 'claim_files',
                  title: '认领文件',
                  description:
                    '改文件前认领要改的文件或目录（相对项目根）。子对话共用一个目录，被别的子对话占着的会列出来，那些不要改。认领留到你的改动被父对话验收（或你被删除、归档）才释放，一轮结束不释放；这一轮改过的文件即使没认领也会记到你名下。',
                  inputSchema: {
                    type: 'object',
                    properties: { paths: { type: 'array', items: { type: 'string' } } },
                    required: ['paths'],
                  },
                },
                {
                  name: 'release_files',
                  title: '释放文件',
                  description:
                    '提前让出认领了却没改的文件（让给别的子对话时用）；不写 paths 让出全部没改过的。改过的文件不能提前释放，等父对话验收后由面板释放。',
                  inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } },
                },
              ]
            : []),
        ]
      : []),
    ...(o.p4Split
      ? [
          {
            name: 'p4_split_changelists',
            title: '按类型分 changelist',
            description:
              'P4 工作区：把改动按文件类型分进各自的 pending changelist（[C++]、[XLSX] 表格、[Lua]、[Other] 各一个），由面板建 changelist 并挪文件，不 submit。要把改动放进 pending 时用它，不要自己建一个把几类混在一起的。缺哪类的描述会先列出各类文件、不动任何东西。',
            inputSchema: {
              type: 'object',
              properties: {
                descriptions: {
                  type: 'object',
                  description:
                    '这次有文件的每一类写一句中文描述，只说改了什么（25 字以内，英文数字算半个；不带 [类型] 标签，不写原因、函数名和文件列表；超长会被退回）',
                  properties: {
                    'C++': { type: 'string' },
                    XLSX: { type: 'string', description: '表格：.xlsx / .xls / .csv 等' },
                    Lua: { type: 'string' },
                    Other: { type: 'string' },
                  },
                },
                from: {
                  type: 'string',
                  description:
                    '从哪个 changelist 分：不写是 default；写 pending 的编号会把混在里面的几类拆开（挪空后删掉原来的）',
                },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    '只分这些文件（本地路径或 depot 路径）；不写分来源里的全部文件。default 里有别的改动时用它只列本次任务的',
                },
              },
              required: ['descriptions'],
            },
          },
        ]
      : []),
    ...(o.cherryPick
      ? [
          {
            name: 'cherry_pick',
            title: 'cherry-pick 到目标',
            description:
              '用户要求把改动 cherry-pick 到项目设置的目标时用它，由面板核对后执行。Git 写 commits（这个对话做的提交，按先后顺序；有不是这次修改的提交整次不做）；P4 写 changelist（用户要搬的 pending，或已经 submit 的编号，别的 stream 上的也行；面板只搬这个 changelist 自己的改动，在目标工作区建一个对应的 pending，不 submit，用户明确要求前也不要自己 p4 submit）。不要自己跑 git cherry-pick / merge、p4 integrate / merge / copy 或复制文件过去；被拒绝时把原因告诉用户；有冲突时面板把冲突留在目标里，把冲突文件和位置告诉用户，由用户自己解决。',
            inputSchema: {
              type: 'object',
              properties: {
                commits: { type: 'array', items: { type: 'string' }, description: 'Git：这个对话做的提交哈希' },
                changelist: {
                  type: 'string',
                  description: 'P4：要搬的 changelist 编号（还没提交的 pending，或已经 submit 的）',
                },
              },
            },
          },
        ]
      : []),
    ...(o.askPush ? [ASK_PUSH_TOOL] : []),
    ...(o.diagnose ? [DIAGNOSIS_TOOL, BUG_CASE_TOOL] : []),
    ...(o.lessons
      ? [
          {
            name: 'project_lessons',
            title: '查看项目教训',
            description:
              '取这个项目的教训（以前返工过的地方写成的规则）：传要改的文件，返回管这些文件的条目全文，最相关的在前；也能按关键词或标签查（例如不对应具体文件的条目、提示里只列了标题的条目）；什么都不传列出全部标题和已有标签。动手改文件前用。',
            inputSchema: {
              type: 'object',
              properties: {
                files: { type: 'array', items: { type: 'string' }, description: '要改的文件或目录，相对项目根' },
                query: {
                  type: 'string',
                  description:
                    '关键词，空格分开的几个词都要出现（标题、说明、起因、范围、标签或 id 里）；传 id 取那一条的全文',
                },
                tags: { type: 'array', items: { type: 'string' }, description: '带其中任一个标签的条目' },
              },
            },
          },
          // 子任务只读教训不记（makeOrchestra 给子任务的 lessons 没有 record）：值得记的交回派它的对话决定
          ...(o.lessons.record
            ? [
                {
                  name: 'record_lesson',
                  title: '记下教训',
                  description:
                    '记一条项目教训，或改写已有的一条，以后这个项目里的 Agent 改到相关文件时都会看到。用户纠正了你的做法、你发现自己的办法不对换了做法才成、或你在修之前改出来的问题时用；写成通用规则，同类的已经有了就带 id 改写那一条。用户的新要求和某条教训冲突且找到两全的做法时，也带 id 改写并在 change 里说明。全局教训只有用户能改。',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      title: {
                        type: 'string',
                        description:
                          '一句话的规则：该怎么做（不是发生了什么），例如「CLI 才有的能力写进 CLI 的配置字段，代码按字段走」',
                      },
                      rule: { type: 'string', description: '展开说明：具体到文件、字段、做法和不要做的事' },
                      cause: { type: 'string', description: '起因：这次哪里返工、用户怎么纠正的，一两句' },
                      paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '它管哪些文件（相对项目根的 glob，** 跨目录，目录名也行）；所有改动都适用时不写',
                      },
                      tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                          '1～3 个主题标签（例如 并发、测试、界面），最多 5 个；先用提示或 project_lessons 列出的已有标签，不另造近义词',
                      },
                      id: {
                        type: 'string',
                        description:
                          '改写已有的那条时填它的 id（project_lessons 或提示里列出的）：用户的新要求和它冲突、你找到两全的做法时用；新记一条不填',
                      },
                      change: {
                        type: 'string',
                        description: '改写时必填：用户的哪条新要求和原来的规则冲突、两全的做法是什么',
                      },
                    },
                    required: ['title', 'rule'],
                  },
                },
              ]
            : []),
        ]
      : []),
    // 共享状态只存在于工作流运行的 task.runs 里，对话模式没有：注册了模型每次调都是「没有共享状态」
    ...(o.sharedState
      ? [
          {
            name: 'read_state',
            title: '读取共享状态',
            description: '读这次运行里所有节点共享的状态（键、值、版本、谁写的），长时间执行时中途用它同步进展。',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'write_state',
            title: '写入共享状态',
            description:
              '写共享状态的一个键：并发节点都能看到，后写的覆盖先写的。用来同步接口、文件分工、进度和结论，写之前先读一遍别覆盖别人刚写的。',
            inputSchema: {
              type: 'object',
              properties: {
                key: { type: 'string', description: '键名，例如 interface、progress、api-changed' },
                value: { type: 'string', description: '值，写清楚别人需要知道的内容' },
              },
              required: ['key', 'value'],
            },
          },
        ]
      : []),
    // 子任务不能再派子任务，Chat 模式不派子任务（canSpawn 为 false）
    ...(!o.canSpawn
      ? []
      : [
          {
            name: 'spawn_agents',
            title: '派出子任务',
            description: o.autoReturn
              ? '派子任务并行处理互不相关的几件事（收集资料、查代码、核实结论、出计划），马上返回它们的 id。派完就可以结束这一轮回复：对话会停下等它们全部做完，结果自动交回给你接着做，不用轮询。子任务不能再派子任务、不能启动工作流或子对话。只拆真正能同时做的事，小事自己做更快。'
              : '派子任务并行处理互不相关的几块工作（收集资料、查代码、核实结论、出计划），马上返回它们的 id，不等它们做完；之后用 wait_agents 取结果，节点结束前没取的结果也会并进你的输出。子任务不能再派子任务。只拆真正能同时做、不会改同一个文件的事，小事自己做更快。',
            inputSchema: {
              type: 'object',
              properties: {
                tasks: tasksField(o),
                // 整批的默认值：只派一个任务时可以直接写在顶层。只读 tasks[i] 的话，模型把 resume 写在顶层时
                // 会被静默丢掉，复看的评审退回默认「子任务」角色 + 新会话（提示词也跟着换了一套）
                agent: batchField(agentField(o)),
                tier: batchField(tierField()),
                resume: resumeField(true),
                params: batchField(paramsField()),
                // 和 create_conversation / run_background 一样：这批子任务全部结束、结果交回时，
                // 计划里这一步标完成；失败或被终止退回进行中并写清原因
                ...(o.plans ? { step: stepField('这批子任务') } : {}),
                ...(o.coordinator ? { route: routeField() } : {}),
              },
              required: ['tasks'],
            },
          },
          {
            name: 'stop_subtask',
            title: '终止子任务',
            description:
              '终止你派出的子任务：方向错了、已经不需要了、卡住不动时用。还在跑的马上结束，还在排队的不再开始，它们按「已终止」交回，不用再等。ids 不写就终止你派出的全部还没结束的子任务。',
            inputSchema: {
              type: 'object',
              properties: {
                ids: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '子任务的 id（spawn_agents 返回的）或标题；不写就是全部还没结束的',
                },
                reason: { type: 'string', description: '为什么终止，一句话' },
              },
              required: ['reason'],
            },
          },
          // 对话里子任务做完会自动交回，不给等待工具：给了模型就会每隔几十秒调一次轮询，白白占着上下文
          ...(o.autoReturn
            ? []
            : [
                {
                  name: 'wait_agents',
                  title: '等待子任务',
                  description:
                    '等派出的子任务做完并取回结果：一直等到它们全部结束（或有人给你传话）才返回，等待期间不占 API 名额，调一次就够，不用轮询；只交回上次取过之后新做完的。做完前不要自己重复它们的工作。',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      ids: { type: 'array', items: { type: 'string' }, description: '子任务的 id；不写等你派出的全部' },
                    },
                  },
                },
              ]),
        ]),
    ...(o.hasMain && !main
      ? [
          {
            name: 'ask_main',
            title: '向主角色提问',
            description:
              '向主 Agent 提问：需求有歧义、几种做法拿不准、和别的节点有冲突时用它，不要自己猜。主 Agent 忙时先返回，回答之后用 read_messages 取。',
            inputSchema: {
              type: 'object',
              properties: { question: { type: 'string', description: '问题，写清楚背景和可选的做法' } },
              required: ['question'],
            },
          },
        ]
      : []),
    ...(o.team ? teamTools(o, main) : []),
    ...submitTools(o),
  ]
}

/** 传话、看消息：有并行的节点或子任务时才有 */
function teamTools(o: Orchestra, main: boolean) {
  return [
    {
      name: 'send_message',
      title: '传话',
      description: main
        ? '给某个 Agent 发指示：正在执行的会马上收到（或在它下次查看消息时），还没开始的开始时会带上。'
        : '给同时执行的其他 Agent 传话：to 写节点 id 或标题。例如告诉并行节点你改了某个接口，让它别重复改。',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: o.hasMain ? '节点 id 或标题；main 表示主 Agent' : '节点 id 或标题',
          },
          text: { type: 'string' },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'read_messages',
      title: '查看消息',
      description: '看别的 Agent 发给你的消息（看过就清掉）。做比较久的事时中途看一下。',
      inputSchema: { type: 'object', properties: {} },
    },
  ]
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError && { isError }) })
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function reportText(r: HelperReport) {
  const head = `### ${r.id}｜${r.title}（${r.status === 'done' ? '完成' : r.status === 'failed' ? '失败' : r.status === 'running' ? '执行中' : '没有执行'}）`
  return [head, r.output, r.error ? `出错：${r.error}` : ''].filter(Boolean).join('\n')
}

/** 执行一个工具调用 */
export async function callOrchTool(o: Orchestra, name: string, a: any, signal?: AbortSignal) {
  switch (name) {
    case 'get_status':
      return text(o.status())
    case 'start_plan':
      // 老会话里模型还记得这个工具：说清楚现在归谁，不悄悄吞掉
      return text('子对话不再启动工作流：工作流由父对话用 start_workflow 启动，按派给你的事直接做', true)
    case 'submit_diagnosis':
      return callDiagnosis(o, a)
    case 'update_bug_case':
      return callBugCase(o, a)
    case 'start_workflow':
      return callStartWorkflow(o, a, routeOf(a?.route))
    case 'set_plan': {
      const r = await o.setPlan({
        title: str(a?.title),
        steps: Array.isArray(a?.steps) ? a.steps : [],
        partial: a?.partial === true,
        summary: str(a?.summary),
      })
      return text(r.info, !r.ok)
    }
    case 'finish_plan': {
      const r = await o.finishPlan(str(a?.summary))
      return text(r.info, !r.ok)
    }
    case 'read_state':
      return text(o.readState())
    case 'project_lessons': {
      if (!o.lessons) return text('这个对话不在项目里，没有项目教训', true)
      const files = Array.isArray(a?.files) ? a.files.map(String) : []
      const tags = Array.isArray(a?.tags) ? a.tags.map(String) : []
      return text(await o.lessons.find(files, { query: str(a?.query), tags }))
    }
    case 'record_lesson': {
      if (!o.lessons) return text('这个对话不在项目里，记不了项目教训', true)
      // 子任务没注册这个工具，但模型可能凭别处看到的名字直接调：说清楚该怎么办，不悄悄吞掉
      if (!o.lessons.record) return text('子任务不记项目教训：值得记的写进交回的结果，由派你的对话决定要不要记', true)
      const title = str(a?.title).trim()
      if (!title) return text('title 不能为空：写一句该怎么做的规则', true)
      const paths = Array.isArray(a?.paths) ? a.paths.map(String).filter((p: string) => p.trim()) : []
      const replaces = str(a?.id).trim()
      const why = str(a?.change).trim()
      if (replaces && !why) return text('改写已有的教训时要写 change：用户的哪条新要求和它冲突、两全的做法是什么', true)
      const r = await o.lessons.record({
        title,
        rule: str(a?.rule).trim(),
        cause: str(a?.cause).trim(),
        paths,
        tags: Array.isArray(a?.tags) ? a.tags.map(String) : [],
        ...(replaces ? { replaces, why } : {}),
      })
      return text(r.info, !r.ok)
    }
    case 'write_state': {
      const key = str(a?.key).trim()
      if (!key) return text('key 不能为空', true)
      const r = o.writeState(key, str(a?.value))
      return text(r.info, !r.ok)
    }
    case 'list_conversations':
      return text(await o.conversations())
    case 'create_conversation': {
      const message = str(a?.message).trim()
      if (!message) return text('message 不能为空：写清楚需求', true)
      const files = Array.isArray(a?.files) ? a.files.map(String).filter(Boolean) : undefined
      const r = await o.createConversation(str(a?.title).trim(), message, files, str(a?.step).trim(), {
        role: str(a?.role).trim() || undefined,
        route: routeOf(a?.route),
        bug: str(a?.kind) === 'bug',
        ...docsFirstArgs(a),
      })
      return text(r.id ? `${r.info}（id: ${r.id}）` : r.info, !r.ok)
    }
    case 'send_to_conversation': {
      const id = str(a?.id).trim()
      const message = str(a?.message).trim()
      if (!id || !message) return text('id 和 message 都要写', true)
      const r = await o.sendToConversation(id, message, str(a?.step).trim(), routeOf(a?.route))
      return text(r.info, !r.ok)
    }
    case 'stop_workflow': {
      const id = str(a?.id).trim()
      if (!id) return text('id 要写：子对话的 id', true)
      const r = o.stopConversationWorkflow(id, str(a?.reason).trim() || '父对话决定终止这次运行')
      return text(r.info, !r.ok)
    }
    case 'run_background': {
      const command = str(a?.command).trim()
      if (!command) return text('command 是空的：写要执行的命令', true)
      const r = await o.runBackground({
        command,
        // 没给名字时用命令第一行：名字会写进推回结果的标题（界面按第一行显示），带换行会把「成功 / 失败」截掉
        name: str(a?.name).trim() || command.split('\n')[0].trim().slice(0, 40),
        cwd: str(a?.cwd).trim(),
        exclusive: a?.exclusive === true,
        ...(Number(a?.timeout_minutes) > 0 && { timeoutMinutes: Number(a?.timeout_minutes) }),
        step: str(a?.step).trim(),
      })
      return text(r.info, !r.ok)
    }
    case 'check_background':
      return text(o.checkBackground(str(a?.id)))
    case 'stop_background': {
      const r = o.stopBackground(str(a?.id))
      return text(r.info, !r.ok)
    }
    case 'begin_edit': {
      const r = await o.beginEdit()
      return text(r.info, !r.ok)
    }
    // submit_build 是旧名字：保活的 CLI 进程拿的还是旧工具列表
    case 'submit_merge':
    case 'submit_build': {
      const r = await o.submitMerge(
        str(a?.note),
        str(a?.tests),
        o.ueBuild === 'child' && o.isolated ? a?.build !== false : undefined,
        handoffInput(a?.handoff),
        triageInput(a?.review_triage),
        overrideInput(a?.review_override),
      )
      return text(r.info, !r.ok)
    }
    case 'request_build': {
      const kids = Array.isArray(a?.children) ? a.children.map(String) : []
      const r = await o.requestBuild(str(a?.note), str(a?.step) || undefined, kids)
      return text(r.info, !r.ok)
    }
    case 'begin_inline_edit': {
      const files = Array.isArray(a?.files) ? a.files.map(String).filter((f: string) => f.trim()) : []
      const r = await o.beginInlineEdit(files, str(a?.reason), routeOf(a?.route))
      return text(r.info, !r.ok)
    }
    case 'end_inline_edit': {
      const r = await o.endInlineEdit()
      return text(r.info, !r.ok)
    }
    case 'use_capability': {
      const params = a?.params && typeof a.params === 'object' && !Array.isArray(a.params) ? a.params : undefined
      const r = o.loadCapability(str(a?.name), params)
      return text(r.info, !r.ok)
    }
    case 'finish_child': {
      const r = await o.finishChild(str(a?.id).trim())
      return text(r.info, !r.ok)
    }
    case 'list_peers':
      return text(await o.listPeers())
    case 'message_peer': {
      const r = await o.messagePeer(str(a?.id), str(a?.text))
      return text(r.info, !r.ok)
    }
    case 'message_parent': {
      const body = str(a?.text).trim()
      if (!body) return text('text 是空的', true)
      const options = Array.isArray(a?.options) ? a.options.map(String).filter((x: string) => x.trim()) : undefined
      const r = await o.toParent(body, a?.question === true, options, undefined, str(a?.wait_fix).trim() || undefined)
      return text(r.info, !r.ok)
    }
    case 'suggest_next_step': {
      const body = str(a?.text).trim()
      if (!body) return text('text 是空的：写清建议用户接下来做什么', true)
      // 推送这类对外操作只在父对话决定：子对话用结构化字段声明一次，命中就不生成卡片、直接退回让它重新给建议
      // （不靠文案里出现「推送」两个字：那既拦不住换个说法，也会误伤「别推送」这类正常建议）
      const remote = str(a?.remote).trim().toLowerCase()
      if (!remote)
        return text(
          'remote 没写：先声明这些建议会不会改远端。只做本地动作写 none；推送 / 创建 PR / P4 submit / 合并到主干不在子对话的处理范围，由父对话决定。改成只有本地动作的建议再来。',
          true,
        )
      if (remote !== 'none')
        return text(
          `建议里不能有对外操作（remote=${remote}）：推送、创建 PR、P4 submit、合并到主干由父对话决定，子对话的完成只是「已合回父对话所在的分支」，不涉及推送。把这类建议去掉，只留你自己能做完的本地动作，再把 remote 写成 none 重新调用。`,
          true,
        )
      const options = (Array.isArray(a?.options) ? a.options : []).map(String)
      const r = await o.toParent(body, true, askOptions(options, 'suggestion'), 'suggestion')
      return text(r.info, !r.ok)
    }
    case 'p4_split_changelists': {
      if (!o.p4Split) return text('这里不是 P4 工作区', true)
      const d = a?.descriptions && typeof a.descriptions === 'object' ? (a.descriptions as Record<string, unknown>) : {}
      const descriptions = Object.fromEntries(
        (['C++', 'XLSX', 'Lua', 'Other'] as const)
          .filter((k) => typeof d[k] === 'string')
          .map((k) => [k, String(d[k])]),
      )
      const files = Array.isArray(a?.files) ? a.files.map(String) : undefined
      const r = await o.p4Split({ descriptions, from: str(a?.from) || undefined, files })
      return text(r.info, !r.ok)
    }
    case 'cherry_pick': {
      if (!o.cherryPick) return text('这个项目没有设置 cherry-pick 目标，请用户到项目设置里设', true)
      const commits = Array.isArray(a?.commits) ? a.commits.map(String) : undefined
      const r = await o.cherryPick({ commits, changelist: str(a?.changelist) || undefined })
      return text(r.info, !r.ok)
    }
    case 'ask_push':
      return callAskPush(o, a)
    case 'claim_files': {
      const paths = Array.isArray(a?.paths) ? a.paths.map(String) : []
      const r = o.claim(paths)
      return text(r.info, !r.ok)
    }
    case 'release_files': {
      const paths = Array.isArray(a?.paths) ? a.paths.map(String) : []
      const r = o.release(paths)
      return text(r.info, !r.ok)
    }
    case 'run_workflow': {
      const input = str(a?.input).trim()
      if (!input) return text('input 是空的：写清楚这次运行要做什么', true)
      const r = o.run(input)
      return text(r.info, !r.ok)
    }
    case 'close_run': {
      const r = o.closeRun()
      return text(r.info, !r.ok)
    }
    case 'spawn_agents': {
      // 顶层写了不认得的字段就报错，不静默丢掉：调用方以为生效了，实际没派成想派的那样
      const unknown = Object.keys(a && typeof a === 'object' ? a : {}).filter((k) => !SPAWN_TOP_FIELDS.includes(k))
      if (unknown.length)
        return text(
          `spawn_agents 不认得顶层字段${unknown.map((k) => `「${k}」`).join('、')}：每个子任务写进 tasks 的每一项；整批共用的 agent、tier 可以直接写在顶层，只派一个任务时 resume 也可以`,
          true,
        )
      const tasks: any[] = (Array.isArray(a?.tasks) ? a.tasks : []).filter((x: unknown) => x && typeof x === 'object')
      // 写了但不是字符串（数字、数组、对象）不能当成「没写」：会被顶层默认值顶掉，
      // 调用方以为写了 agent / tier / resume，实际一个都没生效
      const notString = (v: unknown) => v !== undefined && v !== null && typeof v !== 'string'
      const wrongType: string[] = ['agent', 'tier', 'resume'].filter((k) => notString(a?.[k])).map((k) => `顶层 ${k}`)
      tasks.forEach((x, i) => {
        for (const k of ['agent', 'tier', 'resume']) if (notString(x[k])) wrongType.push(`tasks[${i}].${k}`)
      })
      if (wrongType.length) return text(`spawn_agents 的 ${wrongType.join('、')} 要写字符串`, true)
      // params 要是对象：写成字符串（'{"task":"清理用例"}'）时静默丢掉，派出去的就是默认那套做法
      const notObject = (v: unknown) => v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))
      const badParams = [a?.params, ...tasks.map((x) => x.params)].some(notObject)
      if (badParams) return text('spawn_agents 的 params 要写对象，例如 {"task": "清理用例"}', true)
      // 顶层 resume 是一批共用的一份：一个会话只能接着跑一轮，配多个任务就说不清谁接它
      const topResume = str(a?.resume) || undefined
      if (topResume && tasks.length > 1)
        return text('顶层 resume 只能配一个子任务：一次派多个时把 resume 写进对应那一项', true)
      // 默认值：任务里写了以任务里的为准（没写才落到顶层），都不写交给引擎（角色沿用原任务、档位跟发起节点）
      const batch = { agent: str(a?.agent) || undefined, tier: str(a?.tier) || undefined, resume: topResume }
      const list: HelperSpec[] = tasks.map((x) => ({
        title: str(x.title),
        instructions: str(x.instructions),
        agent: str(x.agent) || batch.agent,
        tier: str(x.tier) || batch.tier,
        resume: str(x.resume) || batch.resume,
        params: x.params ?? a?.params ?? undefined,
        review: briefOf(x.review),
      }))
      // 点名的计划步骤由面板在子任务全部结束后收口（见 engine.ts 的 settleHelperWaits）
      const stepId = str(a?.step).trim()
      const r = o.spawn(list, stepId || undefined, { route: routeOf(a?.route) })
      if (r.error) return text(r.error, true)
      // 整批都转交父对话了：本地一个也没派，不能写成「已派出 0 个子任务」
      if (!r.ids.length) return text(r.info || '已交给父对话创建这些子任务')
      const body = o.autoReturn
        ? `已派出 ${r.ids.length} 个子任务：${r.ids.join('、')}\n可以结束这一轮回复了，它们全部做完后结果会自动交回给你。`
        : `已派出 ${r.ids.length} 个子任务：${r.ids.join('、')}\n用 wait_agents 取结果。`
      return text([body, r.info].filter(Boolean).join('\n'))
    }
    case 'stop_subtask': {
      const ids = Array.isArray(a?.ids) ? a.ids.map(String).filter((x: string) => x.trim()) : []
      const why = str(a?.reason).trim() || '派它的对话决定不再需要'
      const r = o.stopHelpers(ids, why)
      return text(r.info, !r.ok)
    }
    case 'wait_agents': {
      const ids = Array.isArray(a?.ids) ? a.ids.map(String) : []
      // 对话里结果会自动交回：老会话里模型还记得这个工具时不陪它等，告诉它结束这一轮。
      // 老会话的模型还会带 seconds：不再理它，短等待只会让它每隔几十秒带着整份上下文再请求一次
      const r = await o.wait(ids, o.autoReturn ? 0 : WAIT_AGENTS_S * 1000, signal)
      if (!r.done.length && !r.running.length)
        return text(r.taken ? `派出的 ${r.taken} 个子任务都已经交回过了，结果在前面。` : '你还没有派出子任务')
      // 没做完的只列 id：标题在派出时的返回里有，每次都重列一遍没有新信息
      const again = o.autoReturn
        ? '不用再查：结束这一轮回复，它们全部做完后结果会自动交回给你。'
        : '有人传话时会提前返回：先处理那条消息（收件箱里的用 read_messages 看），再调用 wait_agents 接着等。'
      return text(
        [
          r.done.length ? `做完 ${r.done.length} 个：\n\n${r.done.map(reportText).join('\n\n')}` : '',
          r.running.length ? `还在执行：${r.running.map((x) => x.id).join('、')}\n${again}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
    }
    case 'submit_verdict':
    case 'submit_result':
    case 'dispatch':
      return callSubmitTool(o, name, a)
    case 'ask_main': {
      const q = str(a?.question).trim()
      if (!q) return text('question 是空的', true)
      const r = await o.ask(q, DEFAULT_WAIT_S * 1000)
      if (r.error) return text(r.error, true)
      if (r.pending) return text('主 Agent 还在处理别的事，回答到了会放进你的消息里，过一会儿用 read_messages 看。')
      return text(`主 Agent 的回答：\n${r.answer || '（没有回答内容）'}`)
    }
    case 'send_message': {
      const to = str(a?.to).trim()
      const body = str(a?.text).trim()
      if (!to || !body) return text('to 和 text 都要写', true)
      const r = await o.send(to, body)
      return text(r.info, !r.ok)
    }
    case 'read_messages': {
      const got = o.inbox()
      return text(got.length ? got.map((m) => `- ${m}`).join('\n') : '没有新消息')
    }
    default:
      return text(`没有这个工具：${name}`, true)
  }
}
