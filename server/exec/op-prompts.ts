import type { BuildOptions } from '../../shared/clis.ts'

/**
 * 审查、压缩这类操作交给 CLI 的提示词（CLI 自己没有对应模式时用）。从 runner.ts 挪出来：runner 只管调度
 */

/** 审查改动时给不支持审查模式的 CLI 的要求 */
export function reviewPrompt(target: Extract<NonNullable<BuildOptions['op']>, { kind: 'review' }>['target']) {
  const what =
    target.type === 'base'
      ? `当前分支相对 ${target.branch} 的改动（git diff ${target.branch}...HEAD）`
      : target.type === 'custom'
        ? target.instructions
        : '工作区里还没提交的改动（git diff HEAD，包括新建的文件）'
  return [
    `请审查${what}。`,
    '只审查，不要修改任何文件。',
    '按严重程度从高到低列出发现的问题：每条写明文件和行号、问题是什么、为什么是问题、建议怎么改。',
    '重点看会导致错误行为的问题（逻辑错误、边界情况、并发、安全、资源泄漏），其次是可维护性；不要列纯粹的格式问题。',
    '没有发现问题就直接说没有问题。',
  ].join('\n')
}

/** Command Code 不能压缩会话：请它把对话整理成摘要，下一轮开新会话时带上 */
export const SUMMARY_PROMPT =
  '请把我们到目前为止的对话整理成一份摘要，用于在新的会话里继续工作：包括要做的事、已经做了什么（改了哪些文件、关键的决定和原因）、' +
  '还没做完的、需要注意的问题。只输出摘要本身，不要做别的事，也不要修改文件。'
