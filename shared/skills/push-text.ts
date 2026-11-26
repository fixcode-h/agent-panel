/**
 * 面板推技能时交给模型的文字（ADR 0083）：开头一句说明这是面板按情境给的技能正文、照它做，
 * 子文件只给路径（入口里写了什么时候读哪个）。推送总量超了上限时只给一行路径。
 * 这些是提示词，不翻译；演示后端和服务端用同一份
 */

export interface SkillPushPiece {
  name: string
  /** 为什么这时推（./when.ts 的 whenReason） */
  why: string
  /** 技能目录（子文件在它下面） */
  dir: string
  /** SKILL.md 去掉 frontmatter 的正文 */
  body: string
  /** SKILL.md 以外的文件（相对技能目录） */
  files: string[]
}

/** 去掉 frontmatter */
export const skillBodyOf = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()

const subFiles = (p: SkillPushPiece) =>
  p.files.length
    ? `子文件在 \`${p.dir}\` 下（${p.files.slice(0, 12).join('、')}${p.files.length > 12 ? ' 等' : ''}），正文写了什么时候读哪个，用到时再读。`
    : ''

/** 推正文 */
export function skillPushText(p: SkillPushPiece, again = false) {
  const head = again
    ? `【面板】上下文压缩过，技能「${p.name}」的正文再给你一次（压缩前推过），接着照它做。`
    : `【面板】技能「${p.name}」的正文：面板看到你${p.why}，把它直接交给你，照它做，不用再去读 SKILL.md；这个对话里不会再推一次。`
  return [head, subFiles(p), `<skill name="${p.name}">\n${p.body}\n</skill>`].filter(Boolean).join('\n')
}

/** 超了推送上限：只给一行路径 */
export function skillPathText(p: Pick<SkillPushPiece, 'name' | 'why' | 'dir'>) {
  return `【面板】技能「${p.name}」这时用得上（${p.why}）：这个对话推送的技能正文已经到上限，先读 \`${p.dir}/SKILL.md\` 再接着做。`
}
