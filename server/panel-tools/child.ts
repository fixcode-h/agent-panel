/**
 * 子对话多出的工具（Orchestra.child）：和父对话通讯、收尾建议交给用户选、请父对话收尾（submit_merge）、
 * 共用目录时认领文件
 */
import { askOptions } from '../../shared/task.ts'
import { HANDOFF_FIELDS, handoffInput } from '../../shared/handoff.ts'
import { overrideInput, triageInput } from '../../shared/review-gate.ts'
import { reply, str, text, type PanelTool } from './types.ts'

export const MESSAGE_PARENT: PanelTool = {
  name: 'message_parent',
  when: (o) => o.child,
  def: (o) => ({
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
  }),
  hint: (_o, at) => (at === 'child' ? 'message_parent 向父对话汇报或提问；' : ''),
  call: async (o, a) => {
    const body = str(a?.text).trim()
    if (!body) return text('text 是空的', true)
    const options = Array.isArray(a?.options) ? a.options.map(String).filter((x: string) => x.trim()) : undefined
    return reply(await o.toParent(body, a?.question === true, options, undefined, str(a?.wait_fix).trim() || undefined))
  },
}

export const SUGGEST_NEXT_STEP: PanelTool = {
  name: 'suggest_next_step',
  when: (o) => o.child,
  def: () => ({
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
  }),
  hint: (_o, at) =>
    at === 'child' ? 'suggest_next_step 把收尾建议交给用户选（总结里要给建议时必须用它，不要只写在结论里）、' : '',
  call: async (o, a) => {
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
    return reply(await o.toParent(body, true, askOptions(options, 'suggestion'), 'suggestion'))
  },
}

export const SUBMIT_MERGE: PanelTool = {
  name: 'submit_merge',
  // submit_build 是旧名字：保活的 CLI 进程拿的还是旧工具列表
  aliases: ['submit_build'],
  when: (o) => o.child && o.canSubmit,
  def: (o) => ({
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
              description: '为什么带着这个问题合并（至少 12 字）：问题的内容、用户为什么要求先合、后续什么时候补',
            },
          },
          required: ['by', 'reason'],
        },
      },
      required: ['tests', 'handoff'],
    },
  }),
  hint: (o, at) =>
    at !== 'child'
      ? ''
      : o.ueBuild === 'child' && o.isolated
        ? 'submit_merge 检查完请父对话收尾（合回原分支后由父对话申请编译，UE 不在子对话里编译）、'
        : o.isolated
          ? 'submit_merge 测试跑通、只剩合回时请父对话收尾（结果会推回来）、'
          : 'submit_merge 评审处置完、测试跑通、只剩收尾时请父对话验收（结果会推回来）、',
  call: async (o, a) =>
    reply(
      await o.submitMerge(
        str(a?.note),
        str(a?.tests),
        o.ueBuild === 'child' && o.isolated ? a?.build !== false : undefined,
        handoffInput(a?.handoff),
        triageInput(a?.review_triage),
        overrideInput(a?.review_override),
      ),
    ),
}

export const CLAIM_TOOLS: PanelTool[] = [
  {
    name: 'claim_files',
    when: (o) => o.child && o.claims,
    def: () => ({
      name: 'claim_files',
      title: '认领文件',
      description:
        '改文件前认领要改的文件或目录（相对项目根）。子对话共用一个目录，被别的子对话占着的会列出来，那些不要改。认领留到你的改动被父对话验收（或你被删除、归档）才释放，一轮结束不释放；这一轮改过的文件即使没认领也会记到你名下。',
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths'],
      },
    }),
    hint: (_o, at) => (at === 'child' ? 'claim_files 改文件前认领（被别的子对话占着的不要改）、' : ''),
    call: (o, a) => reply(o.claim(Array.isArray(a?.paths) ? a.paths.map(String) : [])),
  },
  {
    name: 'release_files',
    when: (o) => o.child && o.claims,
    def: () => ({
      name: 'release_files',
      title: '释放文件',
      description:
        '提前让出认领了却没改的文件（让给别的子对话时用）；不写 paths 让出全部没改过的。改过的文件不能提前释放，等父对话验收后由面板释放。',
      inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } },
    }),
    call: (o, a) => reply(o.release(Array.isArray(a?.paths) ? a.paths.map(String) : [])),
  },
]
