import { shellNote } from '../shared/shells.ts'
import { lastShell } from './shells.ts'
import { askOptions } from '../shared/task.ts'
import type { HelperReport, HelperSpec, Orchestra } from '../shared/engine.ts'

/**
 * 编排工具：工作流节点和对话每次调用 CLI 时，绑定在调用它的节点上（执行引擎的 Orchestra）。
 * 节点用它派子 Agent 并行处理、取回结果、查各 Agent 的状态、向主 Agent 提问、给别的 Agent 传话；
 * 项目对话用它分派子对话，子对话用它和父对话通讯、认领文件。
 * 它和提问、等下一句这些工具挂在同一个面板 MCP（ask-mcp.ts 的 panel）上：一次调用只连一个面板服务。
 * 工具调用不能等太久（Codex 默认 60 秒超时），等待都有上限
 */

/** 一次工具调用里最多等多久（秒） */
const MAX_WAIT_S = 50
const DEFAULT_WAIT_S = 40

/** 交给哪个 Agent：列出通用 Agent，模型不用猜名字 */
function agentField(o: Orchestra) {
  const list = o.common.map((a) => `「${a.name}」${a.description ? `（${a.description}）` : ''}`).join('、')
  return {
    type: 'string',
    description: `交给哪个角色（名字）；不写用必备角色「子任务」${list ? `。也可以点名这些通用角色：${list}` : ''}`,
  }
}

const tasksField = (o: Orchestra) => ({
  type: 'array',
  description: '每一项是一个子任务，互相之间不能有依赖',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '子任务的短标题（显示在任务进度里）' },
      instructions: { type: 'string', description: '要做什么、范围、产出；子任务只看得到这些和用户需求' },
      agent: agentField(o),
      tier: { type: 'string', enum: ['high', 'medium', 'low'], description: '模型档位；不写跟你一样' },
    },
    required: ['title', 'instructions'],
  },
})

/** 计划步骤：开出去的等待挂在哪一步上 */
const stepField = (what: string) => ({
  type: 'string',
  description: `计划里哪一步在等${what}（步骤 id，见 set_plan 返回的计划）：这一步会标成等待中，结果回来自动推给你；不在计划里的不写`,
})

const planItem = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '已有步骤的 id（set_plan 返回的计划里有）；新步骤不写' },
    title: { type: 'string', description: '步骤名：要做的一件事，10–30 字' },
    status: {
      type: 'string',
      enum: ['pending', 'running', 'waiting', 'done'],
      description: '待做 / 进行中 / 等待中 / 完成',
    },
    note: { type: 'string', description: '一句备注：在等什么、卡在哪；没有不写' },
  },
  required: ['title'],
}

/** 后台命令在哪个 shell 里跑（设置里的命令行环境），Agent 按它的语法写命令 */
const shellHint = () => {
  const sh = lastShell()
  return sh ? shellNote(sh) : ''
}

export function orchTools(o: Orchestra) {
  const main = o.self.endsWith('@main')
  return [
    {
      name: 'get_status',
      title: '查看节点状态',
      description: '查看这次运行里各节点和派出的子 Agent 的状态、结果摘要，按层级缩进。传话、等结果前先用它找节点 id。',
      inputSchema: { type: 'object', properties: {} },
    },
    ...(o.canBeginEdit
      ? [
          {
            name: 'begin_edit',
            title: '开独立分支',
            description:
              '确定要改文件时先调用：面板从当前目录开一个独立分支。成功后用一两句写下查到的情况和打算怎么改，然后马上结束这一轮，面板会在独立分支的目录里开新会话接着做。调用前不要改任何文件。',
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
                ...(o.plans ? { step: stepField('这条命令') } : {}),
              },
              required: ['command'],
            },
          },
          {
            name: 'check_background',
            title: '查看后台命令',
            description: '查后台命令的状态和最近的输出；不写 id 列出这个对话的全部。结果会自动推回来，不需要轮询。',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        ]
      : []),
    ...(o.plans
      ? [
          {
            name: 'set_plan',
            title: '更新计划',
            description:
              '列出或更新这个对话的执行计划，每次交整份列表（已有的步骤带 id）。最多两层：主步骤和子步骤。步骤一多（10 条以上）就分两批交：一批带 partial: true 只写要变的步骤，没写到的步骤留在计划里不动，免得一次拼一大段 JSON 拼错。完成的步骤不能再改，同样的内容要再做就新加一步；步骤全部完成后这份计划就结束，之后的新内容直接开新计划。返回合并后的计划和每一步的 id。',
            inputSchema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '这份计划的名字（开新计划时写）' },
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
              '主动结束这份计划（步骤全部完成时计划本来就会自动结束）。不用写总结，传了也不保存；之后有新内容用 set_plan 开新计划。',
            inputSchema: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string',
                  description: '不用写：给这一步留的兼容字段，传了也不会保存',
                },
              },
            },
          },
        ]
      : []),
    ...(o.planning
      ? [
          {
            name: 'start_plan',
            title: '启动工作流',
            description:
              '按工作流启动一次计划执行：节点全部新建，同一层没有依赖的节点同时执行，跑完把结果交回对话。需要完整流程、跨模块改动或较大的研究时用；简单任务直接在对话里做更快。',
            inputSchema: {
              type: 'object',
              properties: {
                workflow: {
                  type: 'string',
                  description: '工作流 id（见提示里的「可用工作流」）；不写用项目默认工作流',
                },
                input: { type: 'string', description: '这次计划要做什么：目标、范围、验收标准' },
                ...(o.plans
                  ? {
                      step: {
                        type: 'string',
                        description:
                          '执行计划里哪个主步骤用这个工作流做（步骤 id），工作流的节点就是它的子步骤；不写就在计划末尾加一步',
                      },
                    }
                  : {}),
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
              '新建一个子对话并把这条需求交给它处理（异步执行，马上返回）。现有子对话都不相关、且需求需要改代码或做较大的研究时用。标题由你分析这条需求后起，不要照抄用户原话的开头几个字。',
            inputSchema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: '你分析后起的短标题（10–20 字），点明要做的功能或问题，能和其他子对话区分开',
                },
                message: { type: 'string', description: '完整的需求和背景，子对话只看得到这些' },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    '这个子对话负责的文件或目录（相对项目根）：共用目录时面板替它认领，别的子对话要等它做完；独立分支时用来核对有没有和别的子对话改到同一个文件（两边改同一文件时 git 常常自动合并、不报冲突）',
                },
                ...(o.plans ? { step: stepField('这个子对话') } : {}),
              },
              required: ['title', 'message'],
            },
          },
          {
            name: 'send_to_conversation',
            title: '交给子对话',
            description:
              '把消息交给一个已有的子对话继续处理（异步执行）。它和这条消息相关时用，id 从 list_conversations 取。',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '子对话 id' },
                message: { type: 'string', description: '要交给它的消息，写清楚和原任务的关系' },
                ...(o.plans ? { step: stepField('这个子对话') } : {}),
              },
              required: ['id', 'message'],
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
              '子对话请你收尾（消息里写着「收尾请求」）时调用：面板把它的独立分支合回你所在的分支、把它计划里的收尾步骤标完成、结束它并删除独立分支和分支，你计划里等它的那一步也标完成。合并就是验收：先看它交的验证结果，不够就别收，用 send_to_conversation 交回要补的。合不进去（冲突）会自动退回给它处理。',
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
              '给父对话发消息：汇报阶段进展、发现和别的任务有关的事、或者需要父对话决定时用。你不能直接联系其他子对话，需要配合都经过父对话。',
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
                  description:
                    '只剩合回时调用：计划其余步骤都做完、后台命令都结束、没有待回答的提问、编译测试在你的独立分支里跑通。面板把你现在的改动提交到你的分支，请父对话收尾：父对话把它合回原分支（合并就是验收）、把计划最后的收尾步骤标完成、结束这个子对话并删除独立分支。完成只是「已合回父对话所在的分支」，不涉及推送。还有没做完的会直接拒绝并说明还差什么；合不进去（冲突）会退回给你。马上返回，调用后结束这一轮。',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      note: { type: 'string', description: '这次改了什么，一句话' },
                      tests: {
                        type: 'string',
                        description:
                          o.ueBuild === 'child'
                            ? '做了哪些不用编译的检查、结果如何，并写明「UE 编译已申请父对话」'
                            : '在独立分支里跑了哪些编译、测试，结果如何（例如「npm run typecheck、npm test 全部通过」）',
                      },
                      ...(o.ueBuild === 'child'
                        ? {
                            build: {
                              type: 'boolean',
                              description:
                                'UE 项目：合回原分支后替你向父对话申请编译（默认 true）；只改文档、注释这类不影响编译的内容时写 false',
                            },
                          }
                        : {}),
                    },
                    required: ['tests'],
                  },
                },
              ]
            : []),
          // 有独立分支的走 submit_merge 的 build：改动要先合回父对话的目录才编得到
          ...(o.ueBuild === 'child' && !o.canSubmit
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
                    '改文件前认领要改的文件或目录（相对项目根）。子对话共用一个目录，被别的子对话占着的会列出来，那些不要改。这一轮结束时自动释放。',
                  inputSchema: {
                    type: 'object',
                    properties: { paths: { type: 'array', items: { type: 'string' } } },
                    required: ['paths'],
                  },
                },
                {
                  name: 'release_files',
                  title: '释放文件',
                  description: '提前释放认领的文件（做完一部分、让给别的子对话时用）；不写 paths 释放全部。',
                  inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } },
                },
              ]
            : []),
        ]
      : []),
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
    // 子任务不能再派子任务
    ...(o.helper
      ? []
      : [
          {
            name: 'spawn_agents',
            title: '派出子任务',
            description: o.autoReturn
              ? '派子任务并行处理互不相关的几件事（收集资料、查代码、核实结论、出计划），马上返回它们的 id。派完就可以结束这一轮回复：对话会停下等它们全部做完，结果自动交回给你接着做，不用轮询。子任务不能再派子任务、不能启动工作流或子对话。只拆真正能同时做的事，小事自己做更快。'
              : '派子任务并行处理互不相关的几块工作（收集资料、查代码、核实结论、出计划），马上返回它们的 id，不等它们做完；之后用 wait_agents 取结果，节点结束前没取的结果也会并进你的输出。子任务不能再派子任务。只拆真正能同时做、不会改同一个文件的事，小事自己做更快。',
            inputSchema: { type: 'object', properties: { tasks: tasksField(o) }, required: ['tasks'] },
          },
          // 对话里子任务做完会自动交回，不给等待工具：给了模型就会每隔几十秒调一次轮询，白白占着上下文
          ...(o.autoReturn
            ? []
            : [
                {
                  name: 'wait_agents',
                  title: '等待子任务',
                  description: `等派出的子任务做完并取回结果。一次最多等 ${MAX_WAIT_S} 秒，没做完的会列出来，过一会儿再调用；做完前不要自己重复它们的工作。`,
                  inputSchema: {
                    type: 'object',
                    properties: {
                      ids: { type: 'array', items: { type: 'string' }, description: '子任务的 id；不写等你派出的全部' },
                      seconds: {
                        type: 'number',
                        description: `最多等几秒（默认 ${DEFAULT_WAIT_S}，最多 ${MAX_WAIT_S}）`,
                      },
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
export async function callOrchTool(o: Orchestra, name: string, a: any) {
  switch (name) {
    case 'get_status':
      return text(o.status())
    case 'start_plan': {
      const input = str(a?.input).trim()
      if (!input) return text('input 是空的：写清楚这次计划要做什么', true)
      const r = o.plan(str(a?.workflow).trim(), input, str(a?.step).trim())
      return text(r.info, !r.ok)
    }
    case 'set_plan': {
      const r = o.setPlan({
        title: str(a?.title),
        steps: Array.isArray(a?.steps) ? a.steps : [],
        partial: a?.partial === true,
      })
      return text(r.info, !r.ok)
    }
    case 'finish_plan': {
      const r = o.finishPlan(str(a?.summary))
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
      const r = await o.createConversation(str(a?.title).trim(), message, files, str(a?.step).trim())
      return text(r.id ? `${r.info}（id: ${r.id}）` : r.info, !r.ok)
    }
    case 'send_to_conversation': {
      const id = str(a?.id).trim()
      const message = str(a?.message).trim()
      if (!id || !message) return text('id 和 message 都要写', true)
      const r = await o.sendToConversation(id, message, str(a?.step).trim())
      return text(r.info, !r.ok)
    }
    case 'run_background': {
      const command = str(a?.command).trim()
      if (!command) return text('command 是空的：写要执行的命令', true)
      const r = await o.runBackground({
        command,
        name: str(a?.name).trim() || command.slice(0, 40),
        cwd: str(a?.cwd).trim(),
        exclusive: a?.exclusive === true,
        step: str(a?.step).trim(),
      })
      return text(r.info, !r.ok)
    }
    case 'check_background':
      return text(o.checkBackground(str(a?.id)))
    case 'begin_edit': {
      const r = await o.beginEdit()
      return text(r.info, !r.ok)
    }
    // submit_build 是旧名字：保活的 CLI 进程拿的还是旧工具列表
    case 'submit_merge':
    case 'submit_build': {
      const r = await o.submitMerge(str(a?.note), str(a?.tests), o.ueBuild === 'child' ? a?.build !== false : undefined)
      return text(r.info, !r.ok)
    }
    case 'request_build': {
      const kids = Array.isArray(a?.children) ? a.children.map(String) : []
      const r = await o.requestBuild(str(a?.note), str(a?.step) || undefined, kids)
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
      const r = await o.toParent(body, a?.question === true, options)
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
      const list: HelperSpec[] = (Array.isArray(a?.tasks) ? a.tasks : [])
        .filter((x: unknown) => x && typeof x === 'object')
        .map((x: any) => ({
          title: str(x.title),
          instructions: str(x.instructions),
          agent: str(x.agent) || undefined,
          tier: str(x.tier) || undefined,
        }))
      const r = o.spawn(list)
      if (r.error) return text(r.error, true)
      return text(
        o.autoReturn
          ? `已派出 ${r.ids.length} 个子任务：${r.ids.join('、')}\n可以结束这一轮回复了，它们全部做完后结果会自动交回给你。`
          : `已派出 ${r.ids.length} 个子任务：${r.ids.join('、')}\n用 wait_agents 取结果。`,
      )
    }
    case 'wait_agents': {
      const ids = Array.isArray(a?.ids) ? a.ids.map(String) : []
      // 对话里结果会自动交回：老会话里模型还记得这个工具时不陪它等，告诉它结束这一轮
      const s = o.autoReturn ? 0 : Math.min(MAX_WAIT_S, Math.max(1, Number(a?.seconds) || DEFAULT_WAIT_S))
      const r = await o.wait(ids, s * 1000)
      if (!r.done.length && !r.running.length) return text('你还没有派出子任务')
      const again = o.autoReturn
        ? '不用再查：结束这一轮回复，它们全部做完后结果会自动交回给你。'
        : '过一会儿再调用 wait_agents。'
      return text(
        [
          r.done.length ? `做完 ${r.done.length} 个：\n\n${r.done.map(reportText).join('\n\n')}` : '',
          r.running.length
            ? `还在执行 ${r.running.length} 个：${r.running.map((x) => `${x.id}｜${x.title}`).join('、')}\n${again}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
    }
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

/** 交给 CLI 的一句用法说明：工具列表模型自己看得到，这里说什么时候用 */
export function orchHint(o: Orchestra) {
  // 子任务只做派给它的那件事：不提派子任务、工作流、子对话这些它用不了的工具
  if (o.helper)
    return '（你有面板工具 panel：get_status 查看其他节点和子任务的状态；read_state / write_state 读写共享状态；send_message 给同时执行的节点传话、read_messages 看别人发给你的。你不能再派子任务、不能启动工作流或子对话。不要用 CLI 自带的子 Agent（Task / agent 这类工具）。）'
  // 通用 Agent 写进说明里：不写的话模型很少想到去派别的 Agent
  const common = o.common.length
    ? `；可以派的通用 Agent：${o.common.map((a) => `「${a.name}」`).join('、')}（spawn_agents 的 agent 写名字）`
    : ''
  const state = 'read_state / write_state 读写本次运行的共享状态，并发节点靠它同步进展；'
  // 子对话（连同它的节点）多两样：和父对话通讯、改文件前先认领
  const bg =
    (o.plans ? 'set_plan 列执行计划、随时更新进度；' : '') +
    (o.canBeginEdit ? '改文件前先调用 begin_edit 开独立分支，开好后结束这一轮；' : '') +
    (o.canBackground ? 'run_background 把要跑很久的命令放到后台（跑完结果自动推回）；' : '')
  const child =
    bg +
    (o.child
      ? `${o.claims ? 'claim_files 改文件前认领（被别的子对话占着的不要改）、' : ''}${o.canSubmit ? (o.ueBuild === 'child' ? 'submit_merge 检查完请父对话收尾（合回原分支后由父对话申请编译，UE 不在子对话里编译）、' : 'submit_merge 测试跑通、只剩合回时请父对话收尾（结果会推回来）、') : o.ueBuild === 'child' ? 'request_build 向父对话申请编译（UE 不在子对话里编译，结果会推回来）、' : ''}suggest_next_step 把收尾建议交给用户选（总结里要给建议时必须用它，不要只写在结论里）、message_parent 向父对话汇报或提问；`
      : '')
  // 对话里派完子任务结束这一轮就行，结果自动交回；工作流节点要自己用 wait_agents 取
  const collect = o.autoReturn ? '派完结束这一轮，结果会自动交回' : '再用 wait_agents 取结果'
  if (o.planning)
    return `（你有面板工具 panel：${o.parentOf ? 'finish_child 收到子对话的收尾请求时合回并结束它；' : ''}${o.coordinator ? `list_conversations 看现有子对话、create_conversation 新建子对话、send_to_conversation 交给已有子对话；` : ''}${o.ueBuild === 'parent' ? 'request_build 收到编译申请时向面板占位编译；' : ''}${o.peers ? 'list_peers / message_peer 和同项目的其他父对话协调；' : ''}start_plan 按工作流启动一次计划；${child}get_status 查看节点状态；${state}send_message 给并行节点传话、read_messages 看别人发给你的；需要并行收集、核实或出计划时用 spawn_agents 派子任务，派完结束这一轮，结果会自动交回${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
  if (o.coordinator)
    return `（你有面板工具 panel：先用 list_conversations 看现有子对话的标题、状态和最近结果，相关就用 send_to_conversation 交给它，需要新建就用 create_conversation；${o.parentOf ? 'finish_child 收到子对话的收尾请求时合回并结束它；' : ''}${o.ueBuild === 'parent' ? '收到编译申请时用 request_build 向面板占位编译；' : ''}${o.peers ? 'list_peers / message_peer 和同项目的其他父对话协调；' : ''}${bg}get_status 查看节点状态；需要并行收集、核实或出计划时用 spawn_agents 派子任务，派完结束这一轮，结果会自动交回${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
  return o.self.endsWith('@main')
    ? `（你有面板工具 panel：${o.planner ? 'run_workflow 按流程图起一次新的运行、close_run 结束这次运行；' : ''}get_status 查看各 Agent 的状态和结果；${state}send_message 给正在执行的 Agent 发指示；需要并行核实时可以用 spawn_agents 派子任务，${collect}${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
    : `（你有面板工具 panel：${child}能拆成互不相关的几块时用 spawn_agents 派子任务同时做，${collect}；get_status 查看其他 Agent 的状态；${state}${o.hasMain ? '拿不准、需要决定时用 ask_main 问主 Agent，不要自己猜；' : ''}send_message 传话，read_messages 看别人发给你的${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
}
