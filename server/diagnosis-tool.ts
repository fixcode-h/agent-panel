/**
 * 面板工具 submit_diagnosis（ADR 0045）：父对话派来的 Bug，子对话查到根因、修之前交诊断报告，用户确认了方案再改。
 * 定义和调用拆在这里，orch-mcp.ts 到了行数上限；校验、记录、等确认的逻辑在 shared/bug-diagnosis.ts
 */
import type { Orchestra } from '../shared/engine.ts'
import type { DiagnosisInput } from '../shared/bug-diagnosis.ts'

const text = (desc: string) => ({ type: 'string', description: desc })

export const DIAGNOSIS_TOOL = {
  name: 'submit_diagnosis',
  title: '交诊断报告',
  description:
    '父对话派来的 Bug：证据链齐了、修之前交诊断报告，用户在弹窗里确认方案或标出疑问。交完结束这一轮，确认之前不要改任何文件；结果会作为新消息交给你。查不出根因也交：rootCause 写「未找到」，fix 写下一步要加的日志和要用户提供什么。用户提了意见后再交新一版，answers 按编号逐条回答。',
  inputSchema: {
    type: 'object',
    properties: {
      symptom: text('现象：期望 vs 实际、触发步骤、频率、是否回归'),
      repro: text('复现：命令 / 测试 / 操作和本轮的真实输出；复现不了写试过什么'),
      location: text('位置：模块、哪一层；调用栈一跳一行（path:line 函数）'),
      evidence: text('证据链：现象 ← 日志原文或测试输出 ← 代码 path:line 的条件或赋值'),
      rootCause: text('根因：一两句；还没证实就写成「假设：……，用 X 确认」'),
      confirmed: { type: 'boolean', description: '根因已经用日志或测试证实；只是假设时写 false' },
      excluded: text('已排除的方向和依据（日志原文、测试结果）'),
      fix: text('修复方案：每处怎么改（一两句）、为什么这是根因而不是症状；不修的顺带发现'),
      files: {
        type: 'array',
        items: { type: 'string' },
        description: '方案里要改的文件（相对项目根），收尾时按它核对',
      },
      risk: text('影响和风险：会影响哪些调用方、旧数据、别的功能'),
      verify: text('验证计划：哪条测试改前失败、改后通过；还要跑哪些测试；没法自动化的手工步骤'),
      answers: {
        type: 'array',
        description: '第 2 版起：按编号回答上一版用户的意见',
        items: {
          type: 'object',
          properties: { id: { type: 'number' }, answer: text('查了什么、结论、补了什么证据或改了哪一节') },
          required: ['id', 'answer'],
        },
      },
    },
    required: ['symptom', 'location', 'evidence', 'rootCause', 'fix', 'files', 'verify'],
  },
}

/** 执行一次 submit_diagnosis：不是父对话派来的 Bug 时没有这个工具 */
export function callDiagnosis(o: Orchestra, a: Record<string, unknown> | undefined) {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const input: DiagnosisInput = {
    symptom: str(a?.symptom),
    repro: str(a?.repro),
    location: str(a?.location),
    evidence: str(a?.evidence),
    rootCause: str(a?.rootCause),
    confirmed: a?.confirmed === true,
    excluded: str(a?.excluded),
    fix: str(a?.fix),
    files: Array.isArray(a?.files) ? a.files.map(String) : [],
    risk: str(a?.risk),
    verify: str(a?.verify),
    answers: (Array.isArray(a?.answers) ? a.answers : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({ id: Number(x.id), answer: str(x.answer) }))
      .filter((x) => Number.isFinite(x.id)),
  }
  const r = o.diagnose
    ? o.diagnose(input)
    : { ok: false, info: '这里不用交诊断报告：只有父对话派来的 Bug 子对话要交。按派给你的事直接做。' }
  return { content: [{ type: 'text', text: r.info }], ...(!r.ok && { isError: true }) }
}
