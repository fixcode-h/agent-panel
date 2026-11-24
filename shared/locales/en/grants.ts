/** 英文词典的一部分，键是中文原文：授权卡统一的按钮和设置 →「授权卡」（shared/grants/kinds.ts） */
export const EN_GRANTS: Record<string, string> = {
  'CLI 的权限请求': 'CLI permission requests',
  门禁放行: 'Gate overrides',
  授权卡: 'Approval cards',
  本对话不再询问: "Don't ask again in this conversation",
  '授权卡上的三个按钮：拒绝、允许一次、本对话不再询问（默认）。选了「本对话不再询问」，这个对话里同一类授权之后自动允许、不再弹卡，对话里会留一行记录；不同类的照常问，新对话重新问。':
    "Approval cards have three buttons: Deny, Allow once, and Don't ask again in this conversation (the default). With Don't ask again, later approvals of the same kind in this conversation are allowed automatically without a card, and a line is left in the conversation; other kinds still ask, and a new conversation asks again.",
  '同一类按授权类型算：命令按程序名、改文件按目录、门禁按是哪一个门禁、插件按插件自己定的类别。':
    'What counts as the same kind depends on the type: commands by program, file edits by folder, gates by which gate, plugins by the category the plugin defines.',
  '同一类：{scope}': 'Same kind: {scope}',
  默认每次都问: 'Asks every time by default',
  '{name}：给「本对话不再询问」': "{name}: offer Don't ask again",
  '只允许这一次，下次同类的还会问': 'Allow just this once; the next one of the same kind will ask again',
  允许一次: 'Allow once',
  '允许这一次，并且这个对话里之后的{rule}都自动允许，不再弹卡（对话里会留一行记录；新对话会重新问）':
    'Allow this time, and automatically allow {rule} for the rest of this conversation without a card (a line is left in the conversation; a new conversation asks again)',
  '门禁 {name} 拦下的操作': 'operations blocked by the gate {name}',
  '插件操作 {name}': 'the plugin operation {name}',
  '同一个程序（git、npm 这类带上子命令）；删除、提权和带管道、串联的命令每次都问':
    'The same program (with the subcommand for tools like git and npm); deleting, elevating, and piped or chained commands always ask',
  '同一个目录（含子目录）里的文件': 'Files in the same folder (including subfolders)',
  使用工具: 'Using tools',
  同一个工具: 'The same tool',
  插件操作: 'Plugin operations',
  '插件自己定的一类（例如同一篇文档、同一种资源操作）；插件没给的每次都问':
    'A category the plugin defines (for example the same document or the same kind of asset operation); without one it always asks',
  '推送授权卡本来就只问一次，回答会记住': 'The push card already asks only once and remembers the answer',
  这个门禁拦下的所有操作: 'Everything this gate blocks',
  同一个钩子拦下的所有操作: 'Everything the same hook blocks',
  子对话收尾时的评审要求: 'The review requirement when a sub-conversation wraps up',
  '「允许一次」只放行这一次；「本对话不再询问」之后这个对话里这个门禁都不再拦。':
    "Allow once lets it through this one time; Don't ask again stops this gate from blocking for the rest of this conversation.",
  '「{name}」拦下的操作': 'operations blocked by "{name}"',
}
