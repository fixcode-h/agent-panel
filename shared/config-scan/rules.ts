import { t } from '../i18n.ts'

/**
 * 配置安全扫描的规则（借鉴 ECC 的 AgentShield，设计稿 designs/ECC借鉴-配置安全扫描与钩子档位-设计稿.md §1.2）。
 * 只做确定性的文本匹配，不调模型；每条规则的 id 稳定（忽略记录、测试都按它），说明写给用户看。
 * 密钥规则不在这里：共用 shared/secret-rules.ts，由 index.ts 接上
 */

export type ScanLevel = 'high' | 'medium' | 'low'
/** 一行文字从哪来：run 会被执行或直接进提示词；example 是文档里的示例代码；manifest 是清单、MCP 配置 */
export type ScanSource = 'run' | 'example' | 'manifest'
export type ScanCategory = 'inject' | 'exfil' | 'exec' | 'mcp' | 'secret' | 'hook'

export interface LineRule {
  id: string
  category: ScanCategory
  level: ScanLevel
  /** 一句话：为什么危险 */
  why: () => string
  re: RegExp
  /** 只查这几类文件（按扩展名，不带点）；不写表示都查 */
  ext?: string[]
}

/** 文字类：Skill、命令、AGENTS.md 这种会进提示词的 md */
const TEXT = ['md', 'mdx', 'markdown', 'txt']

export const LINE_RULES: LineRule[] = [
  {
    id: 'inject.zero-width',
    category: 'inject',
    level: 'high',
    why: () => t('有看不见的零宽字符或文字方向控制符，可能藏着给模型的指令'),
    // 文件开头的 BOM（\uFEFF）不算，index.ts 里先去掉
    re: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/,
  },
  {
    id: 'inject.override',
    category: 'inject',
    level: 'high',
    why: () => t('要模型忽略之前的指令，是典型的提示注入写法'),
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|messages?)|忽略(?:掉)?(?:之前|以上|上面|前面|系统)(?:的)?(?:所有)?(?:指令|指示|提示词?|规则|要求)/i,
    ext: TEXT,
  },
  {
    id: 'inject.conceal',
    category: 'inject',
    level: 'high',
    why: () => t('要模型对用户隐瞒正在做的事'),
    re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention|reveal|show)\b[^.\n]{0,40}\b(?:the\s+)?user\b|(?:不要|别|不许|切勿)(?:告诉|告知|提醒|让)用户|对用户(?:隐瞒|保密)/i,
    ext: TEXT,
  },
  {
    id: 'inject.no-confirm',
    category: 'inject',
    level: 'medium',
    why: () => t('要模型不经用户确认就执行，绕过确认这一步'),
    re: /\bwithout\s+(?:asking|confirmation|confirming|approval|user\s+(?:consent|approval|confirmation))\b|\bno\s+need\s+to\s+(?:ask|confirm)\b|(?:无需|不用|不必|不需要)(?:问|询问|征求|向|跟|和)?用户(?:的)?(?:确认|同意|授权)|(?:无需|不用|不必|不需要)(?:问|询问|征求)用户|(?:无需|不用|不必|不需要)(?:确认|授权)(?:就|直接)?(?:执行|运行|删除|推送|安装)/i,
    ext: TEXT,
  },
  {
    id: 'inject.hidden-comment',
    category: 'inject',
    level: 'medium',
    why: () => t('HTML 注释在渲染后看不见，里面却写着给模型的话'),
    re: /<!--(?:(?!-->).)*\b(?:assistant|AI|agent|claude|codex|model|LLM)\b|<!--(?:(?!-->).)*(?:模型|助手|智能体)/i,
    ext: TEXT,
  },
  {
    id: 'exfil.sensitive-send',
    category: 'exfil',
    level: 'high',
    why: () => t('读取本机凭据（SSH 私钥、云凭据、.env）后往外发'),
    re: /(?:~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.npmrc|\.env\b|\.agent-panel)[^\n]*(?:\bcurl\b|\bwget\b|\bfetch\(|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\bnc\s)|(?:\bcurl\b|\bwget\b|Invoke-WebRequest|Invoke-RestMethod)[^\n]*(?:~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.env\b|\.agent-panel)/i,
  },
  {
    id: 'exfil.encode-send',
    category: 'exfil',
    level: 'high',
    why: () => t('把内容编码后通过网络发出去，常见于偷偷外传'),
    re: /\bbase64\b[^\n|]*\|[^\n]*(?:\bcurl\b|\bwget\b|\bnc\s)|(?:\bcurl\b|\bwget\b)[^\n]*\$\(\s*(?:cat|base64)\b/i,
  },
  {
    id: 'exec.pipe-shell',
    category: 'exec',
    level: 'high',
    why: () => t('把网上下载的脚本直接交给 shell 执行，内容随时可能被换掉'),
    re: /(?:\bcurl\b|\bwget\b|Invoke-WebRequest|\biwr\b|Invoke-RestMethod|\birm\b)[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|Invoke-Expression|python3?|node|pwsh|powershell)\b/i,
  },
  {
    id: 'exec.reverse-shell',
    category: 'exec',
    level: 'high',
    why: () => t('反弹 shell：把本机的命令行交给远端控制'),
    re: /\/dev\/tcp\/|\bnc(?:at)?\s+(?:-\S+\s+)*-[a-z]*e\b|\bbash\s+-i\s*>&|\bsocat\b[^\n]*\bexec:/i,
  },
  {
    id: 'exec.rm-home',
    category: 'exec',
    level: 'high',
    why: () => t('递归删除根目录或家目录'),
    re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-\S+\s+)*(?:~|\$HOME|\/|\/\*|~\/\*)(?=\s|$|["';])|Remove-Item\s+[^\n]*(?:\$HOME|~|C:\\)\s*[^\n]*-Recurse/i,
  },
  {
    id: 'exec.skip-permissions',
    category: 'exec',
    level: 'medium',
    why: () => t('让编码 CLI 跳过所有权限确认运行'),
    re: /--dangerously-[a-z-]+|--yolo\b/,
  },
  {
    id: 'mcp.bind-all',
    category: 'mcp',
    level: 'medium',
    why: () => t('服务监听 0.0.0.0，局域网里的其他机器也能连上'),
    re: /\b0\.0\.0\.0\b/,
    // 只查配置和 shell 脚本：JS / Python 库代码里 0.0.0.0 多是默认值说明，误报太多
    ext: ['json', 'jsonc', 'toml', 'yaml', 'yml', 'sh', 'bash', 'ps1'],
  },
  {
    id: 'mcp.auto-approve',
    category: 'mcp',
    level: 'medium',
    why: () => t('工具调用自动批准，模型调用它不再问用户'),
    re: /"(?:autoApprove|alwaysAllow|auto_approve)"\s*:\s*(?:true|\[\s*"\*"|\[\s*"[^"\]]+")|"trust"\s*:\s*true/,
    ext: ['json', 'jsonc', 'toml', 'yaml', 'yml'],
  },
  {
    id: 'hook.swallow',
    category: 'hook',
    level: 'low',
    why: () => t('把错误吞掉了：出了问题用户看不到'),
    re: /\|\|\s*true\b|2>\s*\/dev\/null|catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    ext: ['sh', 'bash', 'zsh', 'js', 'mjs', 'cjs', 'ts', 'ps1', 'py'],
  },
]

/** 规则 id → 说明（密钥和 MCP 的结构规则不在 LINE_RULES 里，index.ts 补） */
export const EXTRA_WHY: Record<string, () => string> = {
  secret: () => t('像是真实的密钥、令牌或私钥，写在文件里会被所有能读到它的人和模型拿到'),
  'mcp.unpinned': () => t('用 npx / uvx 运行没有固定版本的包，每次启动都可能拉到别人新发的代码'),
}
