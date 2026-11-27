/**
 * 搜索规范正文（用户 2026-11-27 定）：每个对话开始时跟角色设定一起放进系统提示词（server/exec/run-setup.ts），
 * 守卫（server/hooks/guards.ts 的 searchSpecDeny）按同一份规范检查每条搜索命令，不合规范的直接退回。
 *
 * 按文件类型的写法复用查找的分类（shared/capability-router/find/categories.ts）：类别以 FindLang 为键，
 * 加了新类别这里不补一段会编译不过。发给 Agent 的提示词，不翻译
 */
import type { FindLang } from '../capability-router/find/types.ts'

/** 每一类文件按规范怎么搜：几行，每行一个场景 + 能照抄的 rg */
export const SEARCH_BY_TYPE: Record<FindLang, { title: string; lines: string[] }> = {
  lua: {
    title: 'Lua（*.lua；UE 项目一般在 Content/Script 下）',
    lines: [
      '有面板的 find 时，找声明、引用、大纲用它并写 lang=lua：`find action=symbol query="Foo" lang=lua under=["<模块目录>"]`',
      '按内容：`rg -n "词" <模块目录> -g \'*.lua\'`',
      '找函数声明：`rg -n "function\\s+[\\w.:]*Foo\\b" <目录> -g \'*.lua\'`；找表字段赋值：`rg -n "[.:]Foo\\s*=" -g \'*.lua\'`',
      '找调用：`A:B(` 和 `A.B(` 两种写法都要搜：`rg -n "[.:]Foo\\(" <目录> -g \'*.lua\'`；按 require 路径找：`rg -n "require.*Module\\.Foo" -g \'*.lua\'`',
    ],
  },
  cpp: {
    title: 'C++（*.h、*.hpp、*.cpp、*.inl；项目在 Source 和插件的 Source 下）',
    lines: [
      '有面板的 find 时，找声明、引用、类成员、头文件用它并写 lang=cpp：`find action=symbol query="UFoo::Bar" lang=cpp`',
      '按内容：`rg -n -w "Foo" Source -g \'*.{h,hpp,cpp,inl}\'`',
      '找类、结构体：`rg -n "(class|struct)\\s+(\\w+_API\\s+)?Foo\\b" <目录> -g \'*.h\'`；找成员函数定义：`rg -n "Foo::Bar\\(" -g \'*.cpp\'`',
      '引擎源码在工作目录外：起点写引擎 Engine/Source 下具体的子目录（绝对路径），不从引擎根目录搜',
    ],
  },
  data: {
    title: '配置、数据、文档（json、ini、csv、xml、yaml、md、txt）和资源',
    lines: [
      '有面板的 find 时可写 lang=data：`find action=text query="990001" lang=data under=["<表目录>"]`',
      '带上扩展名：`rg -n "词" <目录> -g \'*.json\'`；ID、数字、键名按原文整词找：`rg -n -F -w "990001" <表目录>`',
      'ini 的键：`rg -n "^\\s*Key\\s*=" <Config 目录> -g \'*.ini\'`',
      "资源（.uasset、.umap 这类二进制，搜内容时面板已跳过）按名字找：`rg --files Content -g '*名字*.uasset'`（显式写了 -g 照样列得出来）",
    ],
  },
  other: {
    title: '看不出类型',
    lines: [
      '先 `rg -l "词" <模块目录>` 看哪些文件命中，从扩展名定类型，再按上面对应的类型缩小起点、带上 -g 搜（find 写上对应的 lang）',
    ],
  },
}

const ORDER: FindLang[] = ['lua', 'cpp', 'data', 'other']

/** 规范里会被退回的程序：给提示词和退回说明共用一句 */
export const NOT_ALLOWED =
  'grep（搜文件时）、find、Get-ChildItem -Recurse、Select-String -Path、findstr、dir /s、ls -R、tree、git grep、fd、ag'

export interface SpecPromptInput {
  /** 项目生效的排除目录（searchExcludeOf 的结果） */
  excludes: string[]
  /** 工作目录是 Git 仓库：rg 还会跳过 .gitignore 里的 */
  git?: boolean
}

/** 交给 Agent 的完整规范 */
export function searchSpecPrompt(i: SpecPromptInput): string {
  const ex = i.excludes.length ? i.excludes.join('、') : ''
  const skip = [ex && `排除目录 ${ex}`, '.uasset、图片、模型、压缩包这类二进制', i.git ? '.gitignore 里的文件' : '']
    .filter(Boolean)
    .join('、')
  return [
    '## 搜索规范（面板强制：不合规范的搜索命令会被直接退回，不执行）',
    `按内容找、按名字找文件都只用 rg。面板给 rg 配好了跳过 ${skip}；别的程序都不认这份配置，大目录会把产物、缓存全扫一遍。`,
    '',
    '### 一、写法',
    '- 按内容找：`rg -n "词" <起点目录> -g \'*.扩展名\'`',
    "- 按名字找文件：`rg --files <起点目录> -g '*名字*'`（不分大小写用 `--iglob`）",
    '- 看一层目录：`ls <目录>`',
    '- 在别的命令的输出里过滤（`p4 opened | grep x`、`… | Select-String x`）不算搜索，照常用',
    `- 不用：${NOT_ALLOWED}`,
    '',
    '### 二、起点',
    '1. 起点写到要找的东西所在的模块目录；没命中再往上一级扩大，不一上来就搜整个项目',
    "2. 从项目根搜必须带文件类型（`-g '*.lua'`、`-t cpp`）",
    '3. 不从盘符根、用户目录、项目的上层目录搜；不在 ~/.vscode、Program Files、面板数据目录里翻程序：要用的程序先看自建工具，只查 PATH 用 `where` / `Get-Command`，找不到就问用户路径',
    `4. 要找的东西在排除目录里${ex ? `（${ex}）` : ''}时，按上面的类型判断它在哪个排除目录，把那个目录明确写成起点（例如 \`rg -n "词" Saved/Logs\`），rg 会照常搜它；不用 \`--no-ignore\`、\`-u\`、\`--hidden\`、\`--no-config\` 把整个项目放开`,
    '',
    '### 三、参数',
    '1. rg 默认递归，不写 `-r`（rg 的 -r 是把匹配换成别的文字，会改坏结果）',
    '2. 「或」写 `A|B`，不写 grep 的 `A\\|B`（rg 里那是找字面的 |）；几个词也可以 `-e A -e B`',
    '3. 按原文找、词里有 `( ) [ ] . * + ? $ ^ { }` 时加 `-F`；ID、键名要整词匹配加 `-w`',
    '4. 不加 `2>/dev/null`、`2>$null`、`--no-messages`、`-ErrorAction SilentlyContinue`：路径写错会被吞掉，看起来像没搜到',
    '5. 命中多时先 `-l`（只列文件）或 `-c`（每个文件几处）看分布，再缩小起点看内容；接了 `| head` 就记住结果被截过',
    '6. 同一个词在同一范围里搜过、之后没改过那些文件，就用上次的结果，不重复搜',
    '',
    '### 四、按文件类型',
    ...ORDER.flatMap((id) => [`- ${SEARCH_BY_TYPE[id].title}`, ...SEARCH_BY_TYPE[id].lines.map((l) => `  - ${l}`)]),
    '',
    '用户明确要求用别的写法时，被退回后按退回说明请用户放行。',
  ].join('\n')
}
