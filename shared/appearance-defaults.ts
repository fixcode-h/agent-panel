/** 外观设置里几项默认值（shared/schema.ts 的 Appearance 用）：单独放一个文件，schema.ts 已经到了行数上限 */

/** 对话和文档正文的行高默认值：原来 1.75 比段距还松，几段连成一块；照 Claude Code 收到 1.65（中文字面大，比它的 1.43 留宽一点） */
export const LINE_HEIGHT_DEFAULT = 1.65

/**
 * 深色主题下主文字的亮度（%）：默认 90。原来照 Claude Code 深色的主文字（#ffffffed，白色 93%），
 * 用户觉得还是偏亮，要求默认 90；纯白在深底上太刺眼
 */
export const DARK_TEXT_LEVEL_DEFAULT = 90
