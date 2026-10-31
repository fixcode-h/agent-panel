import type { EngineHost } from '../../shared/engine.ts'
import type { CliEvent } from './parsers.ts'

type AskEvent = Extract<CliEvent, { type: 'ask' }>

/** 子对话的提问工具交给父对话时的正文和选项：一次问了几个问题时逐条写出，选项只取单个问题的 */
export function childQuestion(ev: Pick<AskEvent, 'title' | 'detail' | 'options' | 'questions'>) {
  const qs = ev.questions ?? []
  if (qs.length > 1)
    return {
      text: qs
        .map(
          (q, i) =>
            `${i + 1}. ${q.question}${q.options.length ? `（可选：${q.options.map((o) => o.label).join(' / ')}）` : ''}`,
        )
        .join('\n'),
      options: [] as string[],
    }
  const q = qs[0]
  const text = q?.question || [ev.title, ev.detail].filter((x) => x?.trim()).join('\n') || ev.title
  const options = q ? q.options.map((o) => o.label) : (ev.options ?? [])
  return { text, options }
}

/**
 * 子对话开着「提问」：问题不在子对话里弹给用户，交给父对话（父对话开着提问再转给用户，关着由它的 AI 作答），
 * 答案按回话交回来；CLI 这边马上拿到「交给谁了」，不卡在等回答上。关着提问时 invoke 已经让它自己选，到不了这里
 */
export function askViaParent(ev: AskEvent, messageParent: NonNullable<EngineHost['messageParent']>) {
  const { text, options } = childQuestion(ev)
  const self = '按你的判断选最合适的做法继续，结论里写清你选了什么。'
  void messageParent(text, true, options, 'question')
    .then((r) =>
      ev.reply({
        allow: false,
        message: r.ok
          ? `这个问题没有直接问用户，已经交给父对话决定：${r.info}`
          : `这个问题没能交给父对话：${r.info}。${self}`,
      }),
    )
    .catch((e: Error) => ev.reply({ allow: false, message: `这个问题没能交给父对话（${e.message}）。${self}` }))
}
