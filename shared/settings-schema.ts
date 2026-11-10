/**
 * 全局设置（Settings）和它用到的几块结构：CLI 设置、档位、外观、元素拾取、文件格式。
 * 从 schema.ts 拆出来，schema.ts 原样转出，引用处不用改。
 * 不引用 schema.ts 的值：schema.ts 用 export * 转出这里，反过来引用会成环，模块初始化时取到未定义的值
 */
import { z } from 'zod'
import { ExperienceSettings } from './experience.ts'
import { RestoreThresholds } from './restore/thresholds.ts'
import { DARK_TEXT_LEVEL_DEFAULT, LINE_HEIGHT_DEFAULT } from './appearance-defaults.ts'
import { MarkdownStyle } from './markdown-style.ts'
import { ComponentStyle } from './component-style.ts'
import { API_PROTOCOLS, ApiConfig } from './accounts.ts'
import { RemoteAccess } from './remote-schema.ts'
import { NotifyChannels, ScheduleWebhook } from './notify-channels.ts'
import { DEFAULT_PRICING_MODEL } from './pricing.ts'
import { DEFAULT_SPEECH_MODEL, SPEECH_MODEL_IDS } from './speech.ts'
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  TTS_ENGINES,
  TTS_MODEL_IDS,
  TTS_SPEED_MAX,
  TTS_SPEED_MIN,
  TTS_VOICE_COUNT,
} from './tts.ts'

/**
 * 文本文件的写法：编码（带不带 BOM）和换行符。
 * 项目在 Windows 上编辑、在 WSL / Linux 里跑脚本时，CRLF 和 BOM 会让 shebang 失效，
 * 所以默认 UTF-8 无 BOM + LF。
 */
export const FILE_FORMATS = ['utf8', 'utf8-bom'] as const
export const FILE_EOLS = ['lf', 'crlf'] as const
export const FileFormat = z.object({
  encoding: z.enum(FILE_FORMATS).catch('utf8').default('utf8'),
  eol: z.enum(FILE_EOLS).catch('lf').default('lf'),
})
export type FileFormat = z.infer<typeof FileFormat>
/** 没配置时用的格式：UTF-8 无 BOM、LF */
export const DEFAULT_FILE_FORMAT: FileFormat = { encoding: 'utf8', eol: 'lf' }

/** 一个档位：模型和思考强度；旧数据只有模型名 */
export const TierSetting = z.preprocess(
  (v) => (typeof v === 'string' ? { model: v } : (v ?? {})),
  z.object({
    model: z.string().trim().default(''),
    effort: z.string().trim().default(''),
    /** 上下文窗口和最大输出（token）；0 表示自动（按模型的默认值，不传给 CLI） */
    context: z.number().int().min(0).default(0),
    maxOutput: z.number().int().min(0).default(0),
  }),
)
export type TierSetting = z.infer<typeof TierSetting>

/**
 * 上下文占用到多少时自动压缩（百分比）。留 30% 给压缩本身的读写和模型输出，
 * 比等 CLI 自己的阈值更早，长对话不容易压到一半就超窗；用户在设置里可以改回「按 Agent 自己的规则」
 */
export const AUTO_COMPACT_DEFAULT = 70

/** 单个 CLI 的本机设置 */
export const CliSettings = z.object({
  enabled: z.boolean().default(true),
  /** 可执行文件；为空时用默认命令名（从 PATH 查找） */
  command: z.string().trim().default(''),
  /** Agent 没有指定模型时使用；可以是具体模型，也可以是档位 @high / @medium / @low */
  defaultModel: z.string().trim().default(''),
  /** Agent 和档位都没指定思考强度时使用；为空不传 */
  defaultEffort: z.string().trim().default(''),
  /** 高 / 中 / 低三档对应的模型和思考强度；为空用内置的建议值 */
  tiers: z.object({ high: TierSetting, medium: TierSetting, low: TierSetting }).default(() => ({
    high: TierSetting.parse({}),
    medium: TierSetting.parse({}),
    low: TierSetting.parse({}),
  })),
  /** 权限模式，取值见 shared/clis.ts 里各 CLI 的 permissions */
  permission: z.string().default(''),
  /** 每次调用都追加的参数 */
  extraArgs: z.array(z.string()).default([]),
  /** 追加的环境变量，例如 API Key、代理 */
  env: z.array(z.object({ key: z.string().trim(), value: z.string() })).default([]),
  /** 用账号（浏览器登录）还是 API（全局设置里配的接口 + 密钥）；两种方式的模型下拉各列各的 */
  authMode: z.enum(['account', 'api']).default('account'),
  /** API 模式用哪个 API（apis 的 id），和用它的哪种协议（ApiConfig.endpoints；空是没选过，按 cliApiProtocol 取默认） */
  apiId: z.string().default(''),
  apiProtocol: z.enum(['', ...API_PROTOCOLS]).default(''),
  /** 在任务页和设置里显示账号额度（5 小时、每周用了多少） */
  showLimits: z.boolean().default(false),
  /** 上下文占用达到这个百分比时自动压缩（默认 70%，见 AUTO_COMPACT_DEFAULT）；0 表示用 CLI 自己的规则 */
  autoCompact: z.number().int().min(0).max(100).default(AUTO_COMPACT_DEFAULT),
  /** 一轮任务最多执行多少回合（模型请求次数）；0 表示用 CLI 自己的默认值（Command Code 是 1000） */
  maxTurns: z.number().int().min(0).max(1000).default(0),
  /** CLI 定义里开关（options）的状态、下拉选项选中的 id；没改过的按定义里的默认值 */
  options: z.record(z.string(), z.union([z.boolean(), z.string().max(60)])).default({}),
})
export type CliSettings = z.infer<typeof CliSettings>

/** 内容区默认宽度 */
export const CONTENT_WIDTH = 1000
export const CONTENT_MAX = 1280

/** 各英文字体默认的空格调整：只有等宽的 Maple Mono 需要收窄 */
export const WORD_SPACING: Record<'inter' | 'maple' | 'plex' | 'system', number> = {
  inter: 0,
  maple: -0.2,
  plex: 0,
  system: 0,
}
/** 默认字间距（em）：默认的 Maple Mono 是等宽字体，字母偏疏，稍微收紧 */
export const LETTER_SPACING_DEFAULT = -0.02
/** 可选的配色：每套在 web/src/index.css 里有浅色、深色两块覆盖（html 上的 data-palette） */
export const PALETTES = ['code', 'claude', 'neutral', 'ocean', 'forest'] as const
export type Palette = (typeof PALETTES)[number]
export const Appearance = z.object({
  /**
   * 配色：默认「Claude Code」（中性灰底、蓝色链接，照 Claude Code 桌面版取色），原来的默认「Claude」（暖灰底、陶土橙）保留可选。
   * 换配色只换颜色和部件的外观，布局不变
   */
  palette: z.enum(PALETTES).catch('code').default('code'),
  /**
   * 界面的英文字体：默认内置的等宽 Maple Mono NL（不带符号连字）；
   * 系统界面字体（Segoe UI / 苹方）、内置的 Inter、IBM Plex Sans 可以换
   */
  uiFont: z.enum(['inter', 'maple', 'plex', 'system']).catch('maple').default('maple'),
  /**
   * 中文字体：默认内置的思源黑体；也可以换内置的 Maple Mono CN（圆一点、和 Maple Mono 英文配套）或系统字体（苹方 / 微软雅黑）。
   * 内置字体按 unicode-range 分片，选了才加载（web/src/lib/appearance.ts 的 ensureCjkFont）
   */
  cjkFont: z.enum(['noto', 'maple', 'system']).catch('noto').default('noto'),
  /** 代码、命令、路径用的等宽字体 */
  monoFont: z.enum(['maple', 'jetbrains']).catch('maple').default('maple'),
  /** 本机装了的字体名，填了就排在最前面，缺的字再用上面选的 */
  customFont: z.string().trim().max(200).default(''),
  /** 界面正文字号（像素），其他文字按比例跟着缩放 */
  fontSize: z.number().min(12).max(18).catch(14).default(14),
  /** 字间距（em）：默认的 Maple Mono 是等宽字体，英文字母偏疏，默认收紧一点（LETTER_SPACING_DEFAULT）；比例字体可以调回 0 */
  letterSpacing: z.number().min(-0.08).max(0.15).catch(LETTER_SPACING_DEFAULT).default(LETTER_SPACING_DEFAULT),
  /** 空格的宽度调整（em，CSS word-spacing）：等宽字体的空格有半个汉字宽，中英文混排时显得空，可以收窄（见 WORD_SPACING）。代码里不调 */
  wordSpacing: z.number().min(-0.4).max(0.3).catch(WORD_SPACING.maple).default(WORD_SPACING.maple),
  /** 对话和文档正文的行高 */
  lineHeight: z.number().min(1.3).max(2.2).catch(LINE_HEIGHT_DEFAULT).default(LINE_HEIGHT_DEFAULT),
  /** 深色主题下主文字的亮度（%）：主文字色往页面底色里混，100 是配色原来的颜色（多半是纯白） */
  darkTextLevel: z.number().min(70).max(100).catch(DARK_TEXT_LEVEL_DEFAULT).default(DARK_TEXT_LEVEL_DEFAULT),
  /** 主区、右栏这些面板的圆角（像素）；0 是直角 */
  // 默认 0：照 Claude Code，主区、右栏贴着排、只用细线分隔，不做圆角面板（2026-10-31 用户要求）
  panelRadius: z.number().min(0).max(24).catch(0).default(0),
  /** 对话、文档里 Markdown 每种元素的样式，只存改过的项（定义和默认值见 shared/markdown-style.ts） */
  markdown: MarkdownStyle,
  /** 设置 → 组件里各部件的微调（圆角、底色、边框……），只存改过的项（定义和默认值见 shared/component-style.ts） */
  components: ComponentStyle,
})
export type Appearance = z.infer<typeof Appearance>

/** 抓取元素用的鼠标按键。左键、右键留给页面自己的交互（点按钮、弹菜单），所以默认为中键 */
export const PICK_BUTTONS = ['middle', 'left', 'right'] as const
export type PickButton = (typeof PICK_BUTTONS)[number]
export const DEFAULT_PICK_BUTTON: PickButton = 'middle'
/** 切换抓取模式的快捷键：`·`（U+00B7），中文输入法下就是反引号那一格 */
export const DEFAULT_PICK_HOTKEY = '·'

/**
 * 开发者模式的「元素抓取」怎么触发：快捷键和抓取用的鼠标按键。
 * 存成字符串 / 名字，手改设置文件也能认；写法看 web/src/lib/hotkey.ts
 */
export const ElementPicker = z.object({
  /** 切换抓取模式（开启 / 退出）的快捷键；在输入框里打字时不触发 */
  hotkey: z.string().trim().min(1).max(40).catch(DEFAULT_PICK_HOTKEY).default(DEFAULT_PICK_HOTKEY),
  /** 抓取用的鼠标按键 */
  button: z.enum(PICK_BUTTONS).catch(DEFAULT_PICK_BUTTON).default(DEFAULT_PICK_BUTTON),
})
export type ElementPicker = z.infer<typeof ElementPicker>

/** 从外网访问面板：默认关闭。打开后另起一个带密码登录的外网专用端口，主端口仍然只给本机用。
 * 外网的请求一律要求登录会话，和本机访问不同。
 */
// 外部访问的设置拆在 remote-schema.ts（schema.ts 有行数上限），这里转出，调用方照旧从 schema 引
export { FrpMapping, RemoteAccess, RemoteFrp, RemoteTailscale } from './remote-schema.ts'

/**
 * 设置里各项默认值的迁移版本：改过默认值的项按版本升级一次。
 * 不用「值正好等于旧默认值」判断，是因为有的项旧默认值本身就是界面上的一个选项（例如自动压缩的 0），
 * 用户显式选回它之后不能再被反复改掉。用户保存过一次设置就视为已迁移（见 server/settings.ts 的 saveSettings）
 */
export const SETTINGS_DEFAULTS_VERSION = 4

export const Settings = z.object({
  /** 见 SETTINGS_DEFAULTS_VERSION */
  defaultsVersion: z.number().int().min(0).catch(0).default(0),
  /** 单个步骤最长运行时间（分钟），超时会停止；0 表示不限制 */
  stepTimeoutMinutes: z.number().int().min(0).max(1440).default(0),
  /** CLI 这么多分钟没有任何输出时提醒，再过同样的时间自动停止；0 表示不检测。比总时长更合适：长任务不会被误杀，卡死的会被发现 */
  idleTimeoutMinutes: z.number().int().min(0).max(1440).default(15),
  /**
   * 子对话这么多分钟没有任何输出时，面板以父对话的名义自动问它当前在做什么、是否卡住；0 表示不问。问过再过这么久
   * 还没回复就停掉、接回原会话重启，重启没恢复就新开子对话接手（见 shared/stuck-child.ts）。和 idleTimeoutMinutes 是两个独立的档位
   */
  childIdleAskMinutes: z.number().int().min(0).max(1440).catch(3).default(3),
  nudgeMax: z.number().int().min(0).max(20).catch(6).default(6), // 已不用（2026-11-05 起提醒不限次数，见 shared/end-turn.ts）：旧设置文件里有，留着免得读写时报错
  /**
   * 对话页切走后，CLI 还停在等下一句的工具上多久（分钟）；0 表示回复完就结束这一轮。
   * 期间这个对话保留一个 CLI 进程，值越大越省重开的时间，同时挂着的进程也越多。
   * 只管空闲会话：正在执行的一轮（切到后台也一样）到点不回收，见 server/tasks.ts 的 keepAliveBusy
   */
  presenceGraceMinutes: z.number().int().min(0).max(1440).default(60),
  /** 关掉后不自动回收：回复完没人看的 CLI 进程一直留着，进程会越攒越多，内存只增不减 */
  reclaimIdleCli: z.boolean().catch(true).default(true),
  resumeAfterRestart: z.boolean().catch(false).default(false), // 重启后自动继续被打断的对话；默认关，见 ADR 0042
  /**
   * 子对话彻底完成后，CLI 还停在等下一句上多久（分钟）再结束；0 表示完成就结束。
   * 这段时间里父对话或用户接着交代，消息直接交给同一个进程，不用冷启动。
   * 只管共用目录的子对话：独立分支的子对话完成时目录就删了，CLI 跟着结束（见 server/tasks/keepalive.ts 的 keepDoneChild）
   */
  childDoneKeepMinutes: z.number().int().min(0).max(1440).catch(5).default(5),
  /**
   * 自动归档：顶层对话（连同子对话）这么多天没动、没在执行、回复也都看过了，就归档（侧栏和列表默认不显示，
   * 筛选「已归档」还能找到，随时取消归档）。0 表示不自动归档
   */
  autoArchiveDays: z.number().int().min(0).max(3650).catch(0).default(0),
  /**
   * 整个面板同时跑的后台命令最多几条（所有对话共用）：超出的排队，前面的跑完一条再开始。
   * 每个子对话的独立分支是不同目录，按目录排队拦不住十几条编译、测试一起跑。
   * 默认 64：一般机器同时跑几十条测试、编译顶得住，只有实在忙不过来时才需要调小
   */
  backgroundLimit: z.number().int().min(1).max(64).catch(64).default(64),
  /** 超过这么大（MB）的文件放进输入框时不上传、不拷进对话目录，直接引用它在本机的路径 */
  largeFileMB: z.number().int().min(1).max(50).catch(10).default(10),
  /**
   * 设置 →「数据」里内存曲线多久采一次（秒）。采样只放在内存里，保留最近两小时，
   * 间隔越小曲线越细，但每次都要读一遍子进程的内存（Windows 上用 PowerShell），别调得太小
   */
  memorySampleSeconds: z.number().int().min(10).max(3600).catch(30).default(30),
  /** 粘贴的纯文字超过这么多字时存成一个文本文件，输入框里放文件卡片；0 表示不转 */
  longPasteChars: z.number().int().min(0).max(1_000_000).catch(5000).default(5000),
  /** Agent 选「系统默认」时使用的 CLI */
  defaultCli: z.string().default('claude'),
  clis: z.record(z.string(), CliSettings).default({}),
  /** 全局的 API：配一次，每个 CLI 都能选用（协议对得上的） */
  apis: z.array(ApiConfig).default([]),
  /** CLI 的显示顺序（设置侧栏、默认 CLI、Agent 的 CLI 选项）；没列出的排在后面 */
  cliOrder: z.array(z.string()).default([]),
  /** 服务启动后用默认浏览器打开面板（只在托管了前端页面时生效，开发模式下页面在 Vite 那边） */
  openBrowser: z.boolean().default(true),
  /** 网络代理：检查更新、下载新版本时用。默认地址和各处的示例见 shared/proxy.ts（只支持 http 代理，SOCKS 用不了）；为空时用环境变量 HTTPS_PROXY / HTTP_PROXY */
  proxy: z.string().trim().default(''),
  /**
   * 是否使用上面填的代理地址。默认打开：加这个开关之前填过地址的人升级后行为不变。
   * 关掉只跳过设置里的地址，环境变量 HTTPS_PROXY 和本机代理自动探测照旧——那两条不是这里的配置
   */
  networkProxyEnabled: z.boolean().catch(true).default(true),
  /**
   * 自动检查面板更新：打开后页面打开时检查一次、之后每小时问一次服务端。
   * 默认关：GitHub 偶尔限流，自动检查只能回旧结果，由用户点「检查更新」更可控（用户要求）
   */
  autoCheckUpdates: z.boolean().catch(false).default(false),
  /** 访问令牌：打开后只有用启动时显示的地址打开过的浏览器能访问，挡住本机其他程序直接调接口 */
  requireToken: z.boolean().default(false),
  /** 外网访问：默认关闭 */
  remoteAccess: RemoteAccess.prefault({}),
  webhook: ScheduleWebhook, // 计划的 Webhook 出站（老配置，已迁成钩子）：定义和说明在 notify-channels.ts
  notifyChannels: NotifyChannels, // 面板外的通知渠道（Webhook），见 notify-channels.ts；地址是凭据，只存在这份设置里
  /**
   * 本机语音输入（见 shared/speech.ts）：默认关，关着时输入框上不显示麦克风按钮，也不下载任何东西。
   * 模型和识别库要用户在设置里自己挑了才下载
   */
  speech: z
    .object({
      enabled: z.boolean().catch(false).default(false),
      /** 识别用哪个模型；设置文件里写成不认识的值时回退到默认模型 */
      model: z.enum(SPEECH_MODEL_IDS).catch(DEFAULT_SPEECH_MODEL).default(DEFAULT_SPEECH_MODEL),
      /** 模型从 hf-mirror.com、识别库从 npmmirror 下载 */
      mirror: z.boolean().catch(false).default(false),
    })
    .prefault({}),
  /**
   * 语音朗读（见 shared/tts.ts），和语音输入分开设置：回复下面的朗读按钮念没折叠的总结。
   * 默认用浏览器自带的语音，开箱就能念；在设置里下载开源的 Kokoro 模型后自动换成本机模型
   */
  readAloud: z
    .object({
      engine: z.enum(TTS_ENGINES).catch('browser').default('browser'),
      model: z.enum(TTS_MODEL_IDS).catch(DEFAULT_TTS_MODEL).default(DEFAULT_TTS_MODEL),
      /** 本机模型的音色（模型里的 speaker id） */
      voice: z
        .number()
        .int()
        .min(0)
        .max(TTS_VOICE_COUNT - 1)
        .catch(DEFAULT_TTS_VOICE)
        .default(DEFAULT_TTS_VOICE),
      /** 语速，1 是正常 */
      speed: z.number().min(TTS_SPEED_MIN).max(TTS_SPEED_MAX).catch(1).default(1),
      /** 浏览器语音的名字；空串是自动挑（优先系统的「自然」语音） */
      browserVoice: z.string().max(200).catch('').default(''),
    })
    .prefault({}),
  /** 项目首页的输入框和任务列表、任务页的对话和节点内容的宽度（像素） */
  /** 最宽 1280：再宽两边的任务进度、右栏会被挤得太窄；以前存的更大的值收到上限 */
  contentWidth: z
    .preprocess((v) => (typeof v === 'number' ? Math.min(CONTENT_MAX, Math.max(640, v)) : v), z.number().int())
    .default(CONTENT_WIDTH),
  appearance: Appearance.prefault({}),
  /** 界面上对用户的称呼（提问卡片「需要用户回答」等）；空时写「用户」 */
  userName: z.string().trim().max(20).default(''),
  /** 新开的会话「提问」开关默认打开：AI 有问题时弹卡片问用户，而不是自己选 */
  askUserDefault: z.boolean().default(false),
  /** 开发者模式：输入框上显示「抓取界面元素」按钮，点选面板界面上的元素引用进对话，让 AI 改面板自己的代码 */
  developerMode: z.boolean().catch(false).default(false),
  /** 抓取元素时用的快捷键和鼠标按键（设置 →「快捷键」里改） */
  elementPicker: ElementPicker.prefault({}),
  /**
   * 全局的文本文件格式：项目没单独设置时用它，默认 UTF-8 无 BOM + LF。
   * 面板自己写的文件（说明文件、部署的全局说明）和交给 Agent 的约定都按它来
   */
  fileFormat: FileFormat.prefault({}),
  language: z.enum(['auto', 'zh', 'en']).default('auto'), // 界面语言：auto 跟随浏览器
  /**
   * 语言设成 auto 时，浏览器识别出的语言（页面加载后回报，见 web/src/lib/data.tsx）。
   * 服务端按它定界面文案和交给 Agent 的回复语言；没有（旧数据、还没打开过页面）才退回系统 locale
   */
  browserLang: z.enum(['zh', 'en']).optional().catch(undefined),
  bugAuthor: z.boolean().catch(true).default(true), // Bug 诊断报告的引入点显示作者（ADR 0046）；关了只显示提交号
  /**
   * 命令行环境：面板替 Agent 跑整行命令（后台命令、合并时编译里「自动」环境的步骤）用哪个 shell。
   * 只在 Windows 上有选择；kind 为空表示按本机检测的推荐（有 Git Bash 用 Git Bash，没有用 WSL，再没有用 cmd）
   */
  shell: z
    .object({
      kind: z.enum(['', 'wsl', 'gitbash', 'powershell', 'cmd']).catch('').default(''),
      /** WSL 的发行版；空时用 WSL 的默认发行版 */
      wslDistro: z.string().trim().max(60).default(''),
    })
    .prefault({}),
  /** UI 设计里生成图片用的 CLI 和模型（目前只有 Codex 内置了生图工具）；模型为空用这个 CLI 的高档 */
  imageGen: z
    .object({
      cli: z.string().default('codex'),
      model: z.string().trim().default(''),
      effort: z.string().default(''),
      /** 同时生成几张图：每张图单独开一个会话（CLI 进程或浏览器里的新对话），最多 10 个 */
      concurrency: z.number().int().min(1).max(10).catch(3).default(3),
      /** 本机生图（ComfyUI）：装在软件目录的 comfyui/ 下 */
      local: z
        .object({
          /** 下载模型用 hf-mirror.com、装依赖用清华 PyPI 镜像 */
          mirror: z.boolean().default(false),
          port: z.number().int().min(1024).max(65535).catch(8188).default(8188),
          /** 已经有 ComfyUI 时填它的地址（例如 http://127.0.0.1:8188），不用再装 */
          url: z.string().trim().default(''),
        })
        .default({ mirror: false, port: 8188, url: '' }),
    })
    .default({
      cli: 'codex',
      model: '',
      effort: '',
      concurrency: 3,
      local: { mirror: false, port: 8188, url: '' },
    }),
  /** UI 设计照原画还原的门槛：位置差几像素算对上、对上的要占多少、切图相似度至少多少 */
  designRestore: RestoreThresholds.prefault({}),
  /**
   * 插件（ADR 0059）：插件 id → 开没开、参数。没有记录 = 关。参数按插件清单里的声明取默认值和校验（shared/plugins）。
   * 老设置里的 blender.path 在解析前搬进 plugins.blender.config.blenderPath（shared/settings.ts）
   */
  plugins: z
    .record(
      z.string(),
      z.object({
        enabled: z.boolean().default(false),
        config: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .catch({})
          .default({}),
      }),
    )
    .catch({})
    .default({}),
  /** 模型目录：三档模型的上下文窗口和最大输出按模型自动识别 */
  modelCatalog: z
    .object({
      /**
       * 模型目录里没有的模型，允许在设置里点「AI 补全」联网查官方数字，
       * 结果写进数据目录的 config/models.json
       */
      aiLookup: z.boolean().default(true),
    })
    .default({ aiLookup: true }),
  /**
   * 用量统计的「计价模型」：按哪个模型的官方 API 单价折算费用（单价表在 shared/pricing.ts）。
   * 存模型 id；找不到时界面显示「未配置单价」，不拿 0 冒充
   */
  usagePricingModel: z.string().default(DEFAULT_PRICING_MODEL),
  /** AI 创建 / 优化 Agent 和工作流 */
  assist: z
    .object({
      /** 默认用哪个 CLI；为空时用第一个已安装的 */
      cli: z.string().default(''),
      model: z.string().trim().default(''),
      /** 用户补充的创建规则，会加进提示词 */
      agentRules: z.string().max(8000).default(''),
      workflowRules: z.string().max(8000).default(''),
    })
    .default({ cli: '', model: '', agentRules: '', workflowRules: '' }),
  experience: ExperienceSettings, // 项目经验：总开关、自动学习、提炼用的模型（shared/experience.ts）
})
export type Settings = z.infer<typeof Settings>
