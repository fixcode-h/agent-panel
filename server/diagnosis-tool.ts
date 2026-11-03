/**
 * 面板工具 submit_diagnosis（ADR 0045）：父对话派来的 Bug，子对话查到根因、修之前交诊断报告，用户确认了方案再改。
 * 定义和调用拆在这里，orch-mcp.ts 到了行数上限；校验、记录、等确认的逻辑在 shared/bug-diagnosis.ts
 */
import type { Orchestra } from '../shared/engine.ts'

const text = (desc: string) => ({ type: 'string', description: desc })

/** 档案的结构化字段（ADR 0046）：update_bug_case 和 submit_diagnosis 共用 */
const CASE_PROPS = {
  level: {
    type: 'string',
    enum: ['quick', 'standard', 'deep'],
    description: '级别：quick 快速 / standard 标准 / deep 深入',
  },
  levelNote: text('升降级的理由（降级必须写）'),
  stack: {
    type: 'array',
    description: '调用栈，从入口到出错点一跳一项',
    items: {
      type: 'object',
      properties: {
        file: text('文件（相对项目根）'),
        line: { type: 'number' },
        fn: text('函数'),
        note: text('这一跳做了什么'),
      },
      required: ['file', 'fn'],
    },
  },
  timeline: {
    type: 'array',
    description: '时间线：现象时间线（event 事件、state 状态流转）+ 变更时间线（change：提交、依赖、配置、数据、环境）',
    items: {
      type: 'object',
      properties: {
        at: text('时间（日志时间戳、提交时间）'),
        source: text('来源：path:line、进程、提交号'),
        kind: { type: 'string', enum: ['event', 'state', 'change'] },
        text: text('发生了什么、关键值'),
        abnormal: {
          type: 'boolean',
          description: '第一个异常事件、引入问题的那次变更',
        },
      },
      required: ['kind', 'text'],
    },
  },
  attribution: {
    type: 'object',
    description: '版本归因：是哪次改动引入的、是谁那边的问题',
    properties: {
      category: {
        type: 'string',
        enum: ['current', 'recent', 'legacy', 'external', 'environment', 'data', 'user', 'unknown'],
        description:
          '责任类别：current 本次改动、recent 近期变更、legacy 历史遗留、external 外部依赖、environment 环境配置、data 数据、user 用户操作、unknown 未确定',
      },
      change: text('提交号 / CL / rev'),
      author: text('作者（照版本记录原文）'),
      date: text('日期'),
      title: text('那次改动的标题'),
      how: {
        type: 'string',
        enum: ['blame', 'bisect', 'diff', 'log', 'none'],
        description: '怎么确定的',
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      note: text('依据；unknown 时写试过什么、还缺什么'),
    },
    required: ['category', 'how'],
  },
  consistency: {
    type: 'array',
    description: '根因怎么解释现象卡的每一条（为什么偶发、为什么只在这个环境、为什么以前没出）',
    items: {
      type: 'object',
      properties: { observation: text('现象'), explanation: text('怎么解释') },
      required: ['observation', 'explanation'],
    },
  },
  hypotheses: {
    type: 'array',
    description: '假设表',
    items: {
      type: 'object',
      properties: {
        text: text('假设'),
        status: { type: 'string', enum: ['confirmed', 'excluded', 'open'] },
        basis: text('依据'),
      },
      required: ['text', 'status'],
    },
  },
  impact: {
    type: 'array',
    description: '影响面：要改的地方会碰到什么',
    items: {
      type: 'object',
      properties: {
        area: text('哪一块'),
        effect: text('怎么受影响'),
        verify: text('怎么验证'),
      },
      required: ['area', 'verify'],
    },
  },
  options: {
    type: 'array',
    description: '候选修法（标准、深入级别至少两个有实质区别的）',
    items: {
      type: 'object',
      properties: {
        id: text('编号，例如 A、B'),
        title: text('一句话'),
        change: text('改法'),
        files: { type: 'array', items: { type: 'string' } },
        covers: text('修得全：修掉了哪些现象和同类现场'),
        misses: text('漏了哪些'),
        surface: text('修改面'),
        risk: text('风险：可能引入的新问题和怎么防'),
        fit: text('契合：合不合现有架构和约定'),
        verifiable: text('可验证：怎么证明修好了'),
      },
      required: ['id', 'title', 'change'],
    },
  },
  chosen: {
    type: 'object',
    description: '选定的方案',
    properties: {
      id: text('options 里的编号'),
      why: text('为什么选它'),
      whyNotOthers: text('为什么不选别的；只有一个方案时写为什么没有别的'),
    },
    required: ['id', 'why'],
  },
  next: text('根因还没证实时：下一步要加哪些日志、要用户提供什么'),
}

/** 原来的几段文字字段 */
const TEXT_PROPS = {
  symptom: text('现象：期望 vs 实际、触发、环境和版本、频率、从什么时候开始'),
  repro: text('复现：命令 / 测试 / 操作和本轮的真实输出、复现率'),
  location: text('模块和层；调用栈也可以写在 stack 里'),
  evidence: text('证据链：现象 ← 日志原文或测试输出 ← 代码 path:line 的条件或赋值'),
  rootCause: text('根因：一两句；还没证实就写成「假设：……，用 X 确认」'),
  confirmed: {
    type: 'boolean',
    description: '根因已经用日志或测试证实；只是假设时写 false',
  },
  excluded: text('已排除的方向和依据'),
  fix: text('修法补充说明（候选方案写在 options 里）'),
  files: {
    type: 'array',
    items: { type: 'string' },
    description: '选定方案要改的文件（相对项目根），收尾时按它核对',
  },
  risk: text('风险补充（影响面写在 impact 里）'),
  verify: text('验证计划：复现用例 + 影响面逐条怎么验证'),
}

/** update_bug_case（ADR 0046）：随查随记的档案草稿 */
export const BUG_CASE_TOOL = {
  name: 'update_bug_case',
  title: '记 Bug 档案',
  description:
    '用户报的 Bug：查的过程中把查到的记进档案草稿（现象、调用栈、时间线、归因、假设、影响面、候选方案……），传哪个字段就换掉哪个字段，数组整组传。草稿跨轮次保留，交诊断报告时自动带上；返回现在在哪个阶段、交报告前还缺什么。方案确认、修完后用 result 记下结果（回归测试、复现用例改前改后、影响面逐条的验证），收尾时面板按它核对。',
  inputSchema: {
    type: 'object',
    properties: {
      ...TEXT_PROPS,
      ...CASE_PROPS,
      result: {
        type: 'object',
        description: '修完的结果（方案确认、改完之后写）',
        properties: {
          reproBefore: text('复现用例改前的输出'),
          reproAfter: text('改后的输出'),
          impactChecks: {
            type: 'array',
            description: '影响面逐条的验证：area 照报告里的影响面写',
            items: {
              type: 'object',
              properties: {
                area: text('影响面'),
                command: text('命令或操作'),
                output: text('本轮输出'),
              },
              required: ['area'],
            },
          },
          regressionTests: {
            type: 'array',
            items: { type: 'string' },
            description: '回归测试：测试文件或用例名；没法自动化的写手工步骤',
          },
          runs: text('偶发问题：跑了几次、坏了几次'),
        },
      },
    },
  },
}

export const DIAGNOSIS_TOOL = {
  name: 'submit_diagnosis',
  title: '交诊断报告',
  description:
    '用户报的 Bug：前五个阶段做完、修之前交诊断报告，用户在弹窗里确认方案或标出疑问。update_bug_case 记过的档案草稿会自动带上，这里只写还没记的；按级别检查缺什么，缺了会退回说清。交完结束这一轮，确认之前不要改任何文件；结果会作为新消息交给你。查不出根因也交：rootCause 写「未找到」、confirmed 写 false，next 写下一步要加的日志和要用户提供什么。用户提了意见后再交新一版，answers 按编号逐条回答。',
  inputSchema: {
    type: 'object',
    properties: {
      ...TEXT_PROPS,
      ...CASE_PROPS,
      answers: {
        type: 'array',
        description: '第 2 版起：按编号回答上一版用户的意见',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            answer: text('查了什么、结论、补了什么证据或改了哪一节'),
          },
          required: ['id', 'answer'],
        },
      },
    },
  },
}

/** 执行一次 submit_diagnosis：不是用户报的 Bug 子对话时没有这个工具 */
export function callDiagnosis(o: Orchestra, a: Record<string, unknown> | undefined) {
  const r = o.diagnose
    ? o.diagnose(a ?? {})
    : {
        ok: false,
        info: '这里不用交诊断报告：只有用户报的 Bug 子对话要交。按派给你的事直接做。',
      }
  return {
    content: [{ type: 'text', text: r.info }],
    ...(!r.ok && { isError: true }),
  }
}

/** 执行一次 update_bug_case */
export function callBugCase(o: Orchestra, a: Record<string, unknown> | undefined) {
  const r = o.bugCase ? o.bugCase(a ?? {}) : { ok: false, info: '这里没有 Bug 档案：只有用户报的 Bug 子对话要记。' }
  return {
    content: [{ type: 'text', text: r.info }],
    ...(!r.ok && { isError: true }),
  }
}
