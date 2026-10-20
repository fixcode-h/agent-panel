import { t } from './i18n.ts'

/**
 * 需要授权的外部 CLI：设置里列出来，用户授权一次，之后 Agent 在任务里可以直接调用。
 * 每个 CLI 的差异（怎么检测登录、怎么授权、怎么退出、怎么认账号）都写在这里，
 * 新增一个工具只要加一份定义，设置页和接口都不用改。
 */
export interface Integration {
  id: string
  name: string
  /** 授权后能做什么，设置页上的一句话 */
  description: string
  /** 可执行文件 */
  command: string
  versionArgs: string[]
  docsUrl?: string
  /** 装这个 CLI 的命令，按平台给 */
  install: Partial<Record<'win32' | 'darwin' | 'linux', string>>
  auth: {
    /** 检测是否已登录：退出码 0 表示已登录 */
    status: string[]
    /** 浏览器授权 */
    login: string[]
    /** 用粘贴的 token 授权，token 从 stdin 传入 */
    token?: string[]
    /** 退出登录 */
    logout: string[]
    /** 从检测输出里认出账号：第一个捕获组是账号名 */
    account?: RegExp
    /** 从授权输出里找一次性授权码：第一个捕获组是码 */
    code?: RegExp
    /** 输出里出现这个就按一次回车（有的 CLI 会停在「按回车打开浏览器」） */
    ready?: RegExp
    /** 没登录时给用户看的一句话；工具自己的输出多半是英文 */
    hint?: string
  }
  /** 每条命令都带上的环境变量（关掉分页器、更新提示等） */
  env?: Record<string, string>
  /** 检测、退出、用 token 授权时额外带上的环境变量（关掉交互提示） */
  quietEnv?: Record<string, string>
}

/** 设置页和接口里的授权状态 */
export interface IntegrationView {
  id: string
  name: string
  description: string
  command: string
  docsUrl: string
  /** 当前平台能直接复制的安装命令 */
  installHint: string
  installed: boolean
  /** 第一行版本信息；没安装时为空 */
  version: string
  authed: boolean
  /** 登录着的账号；有的工具认不出来时为空 */
  account: string
  /** 支持在面板里走浏览器授权 */
  browserAuth: boolean
  /** 支持用粘贴的 Token 授权 */
  tokenAuth: boolean
  /** 支持退出登录 */
  canLogout: boolean
  /** 没登录时给用户看的一句话（工具输出多半是英文） */
  hint: string
  /** 检测输出的末尾几行：没登录、多个账号时给用户看 */
  detail: string
}

/** 正在进行的授权 */
export interface IntegrationLoginJob {
  id: string
  integration: string
  status: 'running' | 'done' | 'failed'
  /** CLI 打印的授权网址 */
  url: string
  /** 一次性授权码，要在浏览器里输入 */
  code: string
  /** CLI 的输出（最后一部分） */
  output: string
  error?: string
  startedAt: number
}

/** GitHub CLI：授权后 Agent 可以直接用 gh 合并分支、看/建 PR、提交 issue */
const github: Integration = {
  id: 'github',
  name: 'GitHub CLI',
  description: t('授权后 Agent 可以直接用 gh 操作 GitHub 远端：合并分支、查看和创建 PR、提交 issue 等。'),
  command: 'gh',
  versionArgs: ['--version'],
  docsUrl: 'https://cli.github.com/',
  install: {
    win32: 'winget install --id GitHub.cli',
    darwin: 'brew install gh',
    linux: 'sudo apt install gh',
  },
  auth: {
    status: ['auth', 'status'],
    // --web 打开浏览器；一次性授权码自己解析出来给用户复制
    login: ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'],
    token: ['auth', 'login', '--with-token', '--hostname', 'github.com'],
    logout: ['auth', 'logout', '--hostname', 'github.com', '--user', '{account}'],
    account: /Logged in to \S+ account (\S+)/,
    code: /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i,
    ready: /Press Enter/i,
    hint: t('还没有登录 GitHub。点「浏览器授权」，或者用 Personal Access Token 授权。'),
  },
  env: { GH_PAGER: 'cat', GH_NO_UPDATE_NOTIFIER: '1' },
  quietEnv: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
}

/** 内置的授权工具；以后加 GitLab 之类只管往这里加一份定义 */
export const INTEGRATIONS: Integration[] = [github]

export const getIntegration = (id: string) => INTEGRATIONS.find((x) => x.id === id)
