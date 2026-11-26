/**
 * 语言代码风格技能的登记表：哪种文件归哪个风格技能、最要紧的几条规则。
 *
 * 为什么要有这张表：CLI 只把技能的名字和描述放进上下文，正文要模型自己决定去读。弱模型（2026-11-26 DeepSeek V4 Flash 的
 * 子对话）整轮改了一堆 Lua 也没读过 lua-code-style，日志照样拆成三行；子对话默认的「执行」角色也没点名这两个技能。
 * 所以第一次改这类文件前，由情境规则（shared/hooks/situational.ts）把这里的要点直接推给模型，不靠它自己想起来；
 * 「开发」角色按「语言」参数常驻的那几句也从这里取，一条规则只写一处。
 *
 * 要点按面板自带的最新版写，本机装的技能副本旧了也不影响这几条。新加一种语言只加一行。
 * 推给模型的文字是提示词，不翻译
 */
export interface CodeStyleSkill {
  /** 技能名（skills/ 下的目录名） */
  skill: string
  /** 「开发」角色「语言」参数的取值 */
  lang: string
  /** 推送里怎么称呼这种代码 */
  label: string
  /** 改这些文件（相对或绝对路径都行）时推 */
  paths: string[]
  /** 最要紧的几条，一段话（「开发」角色常驻的也是这一段，加字要过提示词预算） */
  rules: string
  /** 只在这些地方换行：只放进推送，不进常驻的角色设定 */
  breaks: string
}

export const CODE_STYLE_SKILLS: CodeStyleSkill[] = [
  {
    skill: 'lua-code-style',
    lang: 'lua',
    label: 'Lua',
    paths: ['**/*.lua'],
    rules:
      '非必要不换行，不按字数或行宽换行，一条语句写一行，条件、return 表达式和日志调用都不拆成续行；不对来源明确的参数做类型判断，只在可能为空处判空；日志标签用所属模块的英文名（如 [ClinkGlasses]，不用中文），带「类名=>函数名」定位，不打高频日志。',
    breaks: '代码块、多行 table、回调函数体、多行字符串',
  },
  {
    skill: 'cpp-code-style',
    lang: 'cpp',
    label: 'C++',
    paths: ['**/*.h', '**/*.hpp', '**/*.cpp', '**/*.cc', '**/*.inl'],
    rules:
      '包括 UE 插件的模块导出规则；非必要不换行，不按字数或行宽换行，条件、return 表达式和 UE_LOG 等日志调用都写一行；日志标签用模块英文名，不用中文。',
    breaks: '代码块、初始化列表、多行初始化、lambda 体、多行字符串',
  },
]

/** 某种语言的要点；没登记的语言为空串 */
export const codeStyleRules = (lang: string) => CODE_STYLE_SKILLS.find((s) => s.lang === lang)?.rules ?? ''

/** 第一次改这类文件前推给模型的一段话 */
export function codeStylePush(s: CodeStyleSkill) {
  return `【面板】你要改 ${s.label} 文件了。写 ${s.label} 按 \`${s.skill}\` 技能：先读它的 SKILL.md 全文（技能列表里有它；读不到就按下面这几条），这一次和之后的 ${s.label} 改动都照它写，刚才写的不符合就马上改掉。最要紧的几条：${s.rules}换行只出现在${s.breaks}；日志调用的括号里不换行，不管多长。`
}
