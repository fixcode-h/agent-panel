/**
 * 面板工具 submit_diagnosis（ADR 0045）：父对话派来的 Bug，子对话查到根因、修之前交诊断报告，用户确认了方案再改。
 * 定义、用法说明和调用都在这里（面板工具注册表的条目）；校验、记录、等确认的逻辑在 shared/bug/diagnosis.ts
 */
import type { Orchestra } from '../shared/engine/host.ts'
import type { PanelTool } from './panel-tools/types.ts'

const text = (desc: string) => ({ type: 'string', description: desc })
const GRADE = { type: 'string', enum: ['good', 'cost', 'bad'] }

/** 档案的结构化字段（ADR 0046）：update_bug_case 和 submit_diagnosis 共用 */
const CASE_PROPS = {
  level: {
    type: 'string',
    enum: ['quick', 'standard', 'deep'],
    description: '级别：quick 快速 / standard 标准 / deep 深入',
  },
  levelNote: text('升降级的理由（降级必须写）'),
  stack: {
    type: 'array',
    description: '调用栈，从入口到出错点一跳一项',
    items: {
      type: 'object',
      properties: {
        file: text('文件（相对项目根）'),
        line: { type: 'number' },
        fn: text('函数'),
        note: text('这一跳做了什么'),
      },
      required: ['file', 'fn'],
    },
  },
  timeline: {
    type: 'array',
    description: '时间线：现象时间线（event 事件、state 状态流转）+ 变更时间线（change：提交、依赖、配置、数据、环境）',
    items: {
      type: 'object',
      properties: {
        at: text('时间（日志时间戳、提交时间）'),
        source: text('来源：path:line、进程、提交号'),
        kind: { type: 'string', enum: ['event', 'state', 'change'] },
        text: text('发生了什么、关键值'),
        abnormal: {
          type: 'boolean',
          description: '第一个异常事件、引入问题的那次变更',
        },
      },
      required: ['kind', 'text'],
    },
  },
  attribution: {
    type: 'object',
    description: '版本归因：是哪次改动引入的、是谁那边的问题',
    properties: {
      category: {
        type: 'string',
        enum: ['current', 'recent', 'legacy', 'external', 'environment', 'data', 'user', 'unknown'],
        description:
          '责任类别：current 本次改动、recent 近期变更、legacy 历史遗留、external 外部依赖、environment 环境配置、data 数据、user 用户操作、unknown 未确定',
      },
      change: text('提交号 / CL / rev'),
      author: text('提交人（照版本记录原文；Git 仓库里面板会按提交号再取一次核对）'),
      date: text('日期'),
      title: text('那次改动的标题'),
      how: {
        type: 'string',
        enum: ['blame', 'bisect', 'diff', 'log', 'none'],
        description: '怎么确定的',
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      note: text('依据；unknown 时写试过什么、还缺什么'),
    },
    required: ['category', 'how'],
  },
  noFix: {
    type: 'object',
    description:
      '查下来不用改代码时写（只在 phase: cause 用）：问题出在配置、数据、本来就这么设计、用法不对或外部依赖。用户同意后不再交修复方案，按 how 告诉用户怎么处理就收尾。之前写过、后来发现要改代码时传 {} 去掉',
    properties: {
      kind: {
        type: 'string',
        enum: ['config', 'data', 'design', 'usage', 'external'],
        description: 'config 改配置、data 处理数据、design 本来就是这么设计的、usage 用法不对、external 外部依赖的问题',
      },
      how: text('用户怎么处理：改哪项配置、怎么处理数据、正确的用法是什么，一步一行'),
    },
  },
  rating: {
    type: 'object',
    description:
      '根因评级（根因证实后必填，报告最上面醒目显示）：tier 是这个错在哪个层次，percent 是你对根因的把握（0–100 的整数）',
    properties: {
      tier: {
        type: 'string',
        enum: ['low', 'mid', 'high'],
        description:
          'low 低级：粗心疏漏（写错名字、漏判空、漏改一处、复制粘贴没改全）；mid 中级：逻辑和边界（条件、顺序、状态没想全）；high 高级：设计、并发时序、跨模块契约',
      },
      percent: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description:
          '把握：证据链三环都有原文、复现用例改前失败的写 90 以上；有一环靠推断的 60–85；还有解释不了的现象不超过 60',
      },
      why: text('一句话：为什么是这个等级、把握为什么是这个数（缺哪条证据）'),
    },
    required: ['tier', 'percent'],
  },
  consistency: {
    type: 'array',
    description: '根因怎么解释现象卡的每一条（为什么偶发、为什么只在这个环境、为什么以前没出）',
    items: {
      type: 'object',
      properties: { observation: text('现象'), explanation: text('怎么解释') },
      required: ['observation', 'explanation'],
    },
  },
  hypotheses: {
    type: 'array',
    description: '假设表：论证时列全候选假设（沿调用栈每个能让结果走偏的分叉），不只眼前这一层',
    items: {
      type: 'object',
      properties: {
        id: text('编号，例如 H1；日志计划的 hypothesis 按它对上'),
        text: text('假设'),
        status: { type: 'string', enum: ['confirmed', 'excluded', 'open'] },
        basis: text('依据'),
      },
      required: ['text', 'status'],
    },
  },
  impact: {
    type: 'array',
    description: '影响面：要改的地方会碰到什么',
    items: {
      type: 'object',
      properties: {
        area: text('哪一块'),
        effect: text('怎么受影响'),
        verify: text('怎么验证'),
      },
      required: ['area', 'verify'],
    },
  },
  options: {
    type: 'array',
    description: '候选修法（标准、深入级别至少两个有实质区别的）',
    items: {
      type: 'object',
      properties: {
        id: text('编号，例如 A、B'),
        title: text('一句话'),
        change: text('改法'),
        files: { type: 'array', items: { type: 'string' } },
        covers: text('修得全：修掉了哪些现象和同类现场'),
        misses: text('漏了哪些'),
        surface: text('修改面'),
        risk: text('风险：可能引入的新问题和怎么防'),
        fit: text('契合：合不合现有架构和约定'),
        verifiable: text('可验证：怎么证明修好了'),
        grades: {
          type: 'object',
          description: '上面六项各自的判定：good 好、cost 有代价、bad 不满足（比较表里画成 ✓ ⚠ ✗）',
          properties: {
            covers: GRADE,
            misses: GRADE,
            surface: GRADE,
            risk: GRADE,
            fit: GRADE,
            verifiable: GRADE,
          },
        },
        touches: {
          type: 'array',
          items: { type: 'string', enum: ['data', 'api', 'config'] },
          description: '会动到的契约：data 数据格式、api 接口、config 配置项（报告最上面会提醒用户）',
        },
      },
      required: ['id', 'title', 'change'],
    },
  },
  chosen: {
    type: 'object',
    description: '选定的方案',
    properties: {
      id: text('options 里的编号'),
      why: text('为什么选它'),
      whyNotOthers: text('为什么不选别的；只有一个方案时写为什么没有别的'),
    },
    required: ['id', 'why'],
  },
  chain: {
    type: 'array',
    description:
      '证据链三环，按顺序各一项：trigger 触发（什么操作、什么输入）→ fault 出错点（哪段代码在什么条件下做错了什么）→ symptom 现象（用户看到什么）；每环 proof 写证据（日志原文、测试输出、path:line）',
    items: {
      type: 'object',
      properties: {
        step: { type: 'string', enum: ['trigger', 'fault', 'symptom'] },
        text: text('这一环：一句话'),
        proof: text('证据的一句说明（原文不要抄在这里，写进 quotes / codeRefs，用 refs 引用编号）'),
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: '这一环引用的原文编号：quotes 的 Q1、codeRefs 的 C1。出错点引用一段代码加一条日志或命令输出',
        },
      },
      required: ['step', 'text', 'proof'],
    },
  },
  codeRefs: {
    type: 'array',
    description:
      '关键代码（优先写这个，代替 codeRef）：一段一项，出错点、触发条件、调用方分开写。只写位置和标记，代码原文由面板交报告时读出来存档；marks.text 面板逐字核对，对不上拒收',
    items: {
      type: 'object',
      properties: {
        id: text('编号：C1、C2…（证据链 refs 引用）'),
        role: {
          type: 'string',
          enum: ['fault', 'trigger', 'caller', 'expected'],
          description: 'fault 出错点、trigger 触发条件、caller 调用方、expected 对照的正确写法',
        },
        file: text('文件（相对项目根）'),
        start: { type: 'number', description: '起始行（按现在的文件，加了临时日志的按加了之后的行号）' },
        end: { type: 'number', description: '结束行（一段最多 30 行，一般 5~15 行）' },
        marks: {
          type: 'array',
          description: '要高亮的地方，一处一项',
          items: {
            type: 'object',
            properties: {
              line: { type: 'number', description: '哪一行' },
              text: text('那一行里真正出错的那几个字（照文件原样，例如 left === 0），不写整行'),
              note: text('行尾说明，20 字以内，例如「提前返回，派发走不到」'),
              level: {
                type: 'string',
                enum: ['fault', 'related', 'skipped'],
                description: 'fault 出错（红）、related 相关的条件和变量（默认，琥珀）、skipped 没执行到（灰）',
              },
            },
            required: ['line'],
          },
        },
      },
      required: ['id', 'file', 'start', 'end'],
    },
  },
  quotes: {
    type: 'array',
    description:
      '日志和命令输出的原文引用，一条一项，正文和证据链用编号引用。不要转述：log 写行号由面板取原文，run 原样复制；只是描述就写 kind: note（报告上标成「描述」）。原文对不上来源拒收',
    items: {
      type: 'object',
      properties: {
        id: text('编号：Q1、Q2…'),
        kind: {
          type: 'string',
          enum: ['log', 'run', 'note'],
          description: 'log 用户贴的日志、run 这个对话里跑过的命令输出、note 描述（截图、用户说的）',
        },
        from: { type: 'number', description: 'log：用户在第几份报告（报告 #n）上贴的日志；不写取最近一次' },
        start: { type: 'number', description: 'log：日志的第几行（报告里「你贴的日志」的行号）' },
        end: { type: 'number', description: 'log：到第几行（一条最多 30 行）' },
        text: text('run：原样复制的输出；log：可以不写，写了要和那几行逐字对上；note：描述'),
        highlight: {
          type: 'array',
          items: { type: 'string' },
          description: '原文里的关键值（例如 left=0），要在原文里逐字出现，报告上高亮',
        },
      },
      required: ['id', 'kind'],
    },
  },
  expectVsActual: {
    type: 'array',
    description: '期望和实际：一个值一项（根因、验证用）',
    items: {
      type: 'object',
      properties: {
        what: text('什么值、什么行为'),
        expected: text('应该是'),
        actual: text('实际是'),
        ref: text('证明实际值的原文编号，例如 Q1'),
      },
      required: ['what', 'expected', 'actual'],
    },
  },
  reproKind: {
    type: 'string',
    enum: ['user', 'constructed', 'test'],
    description:
      '复现用的是什么：user 用户的数据 / 环境、constructed 自己构造的数据（只算推演，不能当排除假设的依据）、test 测试用例',
  },
  codeRef: {
    type: 'object',
    description: '旧写法，一段关键代码；优先写 codeRefs',
    properties: {
      file: text('文件（相对项目根）'),
      start: { type: 'number', description: '起始行' },
      end: { type: 'number', description: '结束行' },
      mark: { type: 'number', description: '出错的那一行（高亮）' },
    },
    required: ['file', 'start', 'end'],
  },
  changes: {
    type: 'array',
    description:
      '选定方案的具体改动：一个文件一项，写这个文件要改什么（一两句，一件事）；files 没写时按它补。交 fix 时改写成实际改了的每个文件（含测试）：what 写改了什么，why 写为什么这么改，面板和实际 diff 对上给用户看，改了却没写的会退回',
    items: {
      type: 'object',
      properties: {
        file: text('文件（相对项目根）'),
        what: text('改什么'),
        why: text('为什么这么改（交 fix 时必写：这处改动怎么解决根因、为什么这样写）'),
        isNew: { type: 'boolean', description: '新建的文件' },
      },
      required: ['file', 'what'],
    },
  },
  next: text('补充说明：下一步还打算查什么'),
  logPlan: {
    type: 'array',
    description:
      '论证阶段：这一轮要加的临时日志（前缀 [排查-<主题>]），一次加够让用户复现一次就能定论：每个待验证的假设至少一处能判真假的，调用栈每一跳一处路标；每处写加在哪、打什么、对应哪个假设',
    items: {
      type: 'object',
      properties: {
        id: text('编号：L1、L2…（打出来的日志带上这个编号）'),
        file: text('文件（相对项目根）'),
        line: { type: 'number' },
        fn: text('函数'),
        print: text(
          "要加的那一行语句原文，以 [排查-<主题>] L<n> 开头，例如 console.log('[排查-金额] L1 shipping=', o.shipping, typeof o.shipping)；不写描述",
        ),
        hypothesis: text('对应的假设编号（H1），或「路标」（标出走到了调用栈哪一跳）'),
      },
      required: ['file', 'print'],
    },
  },
  collect: {
    type: 'object',
    description: '论证 / 验证阶段：用户怎么复现、日志在哪、过滤条件、每种结果说明什么（验证阶段写看到什么算修好了）',
    properties: {
      steps: { type: 'array', items: { type: 'string' }, description: '复现步骤，一步一项' },
      where: text('日志在哪：日志文件路径、控制台、浏览器开发者工具'),
      filter: text('过滤条件，例如 [排查-拖线]'),
      expect: text('论证：判定表，每个假设看到什么算证实或排除、都对不上时看路标停在哪一跳；验证：看到什么算修好了'),
      outcomes: {
        type: 'array',
        description: 'expect 的结构化写法（优先写这个）：一种结果一项，see 看到什么、means 说明什么',
        items: {
          type: 'object',
          properties: {
            see: text('看到什么'),
            means: text('说明什么'),
            match: {
              type: 'object',
              description: '可核对的写法：日志计划的某处出现了 / 没出现（面板拿到日志后自己判断对上了哪一项）',
              properties: {
                point: text('日志计划编号，例如 L2'),
                seen: { type: 'boolean', description: 'true 出现了、false 没出现' },
              },
              required: ['point', 'seen'],
            },
          },
          required: ['see', 'means'],
        },
      },
    },
    required: ['steps', 'expect'],
  },
}

/** 原来的几段文字字段 */
const TEXT_PROPS = {
  symptom: text('现象：期望 vs 实际、触发、环境和版本、频率、从什么时候开始'),
  repro: text('复现：命令 / 测试 / 操作和本轮的真实输出、复现率'),
  location: text('模块和层；调用栈也可以写在 stack 里'),
  evidence: text('证据链：现象 ← 日志原文或测试输出 ← 代码 path:line 的条件或赋值'),
  rootCause: text('根因：一两句；还没证实就写成「假设：……，用 X 确认」'),
  confirmed: {
    type: 'boolean',
    description: '根因已经用日志或测试证实；只是假设时写 false',
  },
  excluded: text('已排除的方向和依据'),
  fix: text('修法补充说明（候选方案写在 options 里）'),
  files: {
    type: 'array',
    items: { type: 'string' },
    description: '选定方案要改的文件（相对项目根），收尾时按它核对',
  },
  risk: text('风险补充（影响面写在 impact 里）'),
  verify: text('验证计划：复现用例 + 影响面逐条怎么验证'),
}

/** update_bug_case（ADR 0046）：随查随记的档案草稿 */
const BUG_CASE_TOOL = {
  name: 'update_bug_case',
  title: '记 Bug 档案',
  description:
    '用户报的 Bug：查的过程中把查到的记进档案草稿（现象、调用栈、时间线、归因、假设、影响面、候选方案……），传哪个字段就换掉哪个字段，数组整组传。草稿跨轮次保留，交诊断报告时自动带上；返回现在在哪个阶段、交报告前还缺什么。方案确认、修完后用 result 记下结果（回归测试、复现用例改前改后、影响面逐条的验证），收尾时面板按它核对。',
  inputSchema: {
    type: 'object',
    properties: {
      ...TEXT_PROPS,
      ...CASE_PROPS,
      result: {
        type: 'object',
        description: '修完的结果（方案确认、改完之后写）',
        properties: {
          reproBefore: text('复现用例改前的输出'),
          reproAfter: text('改后的输出'),
          impactChecks: {
            type: 'array',
            description: '影响面逐条的验证：area 照报告里的影响面写',
            items: {
              type: 'object',
              properties: {
                area: text('影响面'),
                command: text('命令或操作'),
                output: text('本轮输出'),
              },
              required: ['area'],
            },
          },
          regressionTests: {
            type: 'array',
            items: { type: 'string' },
            description: '回归测试：测试文件或用例名；没法自动化的写手工步骤',
          },
          commands: {
            type: 'array',
            items: { type: 'string' },
            description:
              '能在项目根直接跑的回归测试命令原文（最多 5 条，你在这个对话里跑过、改前失败改后通过的那几条，例如 npx vitest run src/a.test.ts）。面板会在改前的代码和现在的代码上各跑一次，真实输出给用户看；交 fix 前写好的，复核通过时用户确认修复就同时算验证通过',
          },
          runs: text('偶发问题：跑了几次、坏了几次'),
        },
      },
    },
  },
}

const DIAGNOSIS_TOOL = {
  name: 'submit_diagnosis',
  title: '交诊断报告',
  description:
    '用户报的 Bug：每到一个关口交一份报告，用户在弹窗里同意、标疑问或贴日志，结果作为新消息交给你。按阶段走：evidence 论证（根因还没证实：写 logPlan 要加的日志、collect 怎么复现和每种结果说明什么，用户同意后加日志、复现，拿到日志再分析，可以多轮）→ cause 根因（证据链齐了、confirmed: true，用户同意才往下）→ plan 修复方案（候选修法比较、files，用户确认才改代码）→ fix 修复（修完交，changes 每个改了的文件写 what 改了什么、why 为什么这么改，面板取实际 diff 给用户看；用户对代码标了疑问就逐条判断：对的改代码、stance: adopted，不对的用事实反驳、stance: disagree，再交 fix；用户确认修复才验证）→ verify 验证（用 update_bug_case 记下 result 后交，collect 写用户怎么验证、看到什么算修好了）。update_bug_case 记过的档案草稿会自动带上，这里只写还没记的；按阶段和级别检查缺什么，缺了会退回说清。交完结束这一轮，用户回复之前不要改任何文件。用户提了意见后改好再交，answers 按编号逐条回答。版本号由面板定：按意见修改、阶段往下走还是同一版，回到更早的阶段或换掉确认过的方案才升一版；跟用户说第几版照返回里的写。',
  inputSchema: {
    type: 'object',
    properties: {
      phase: {
        type: 'string',
        enum: ['evidence', 'cause', 'plan', 'fix', 'verify'],
        description:
          '这一份的阶段：evidence 论证、cause 根因、plan 修复方案、fix 修复（修完给用户看代码）、verify 验证',
      },
      ...TEXT_PROPS,
      ...CASE_PROPS,
      whatChanged: text('第 2 份起：相比上一份改了什么，一两句（写在报告最上面）'),
      answers: {
        type: 'array',
        description: '用户提了意见后再交时：按编号逐条回应用户上一轮的标注（疑问、改方案、补充信息都要）',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            answer: text('查了什么、结论、补了什么证据或改了哪一节'),
            stance: {
              type: 'string',
              enum: ['adopted', 'explained', 'disagree', 'used'],
              description:
                'adopted 采纳并改了、explained 解释清楚不用改、disagree 不同意（写理由）、used 补充信息已用上（写用在哪一节、对结论有没有影响）',
            },
          },
          required: ['id', 'answer'],
        },
      },
    },
    required: ['phase'],
  },
}

/** request_logs：同意加日志后，加好了日志、自己复现不了，请用户复现贴日志 */
const REQUEST_LOGS_TOOL = {
  name: 'request_logs',
  title: '请用户复现',
  description:
    '用户报的 Bug：用户同意了论证那一版的日志计划、你按计划加好临时日志，自己又复现不了时调用：写这次实际加的位置和复现步骤，面板请用户复现、贴日志。调用后结束这一轮，日志会作为新消息交给你。自己能复现（跑测试、跑命令）就不用调，分析后直接交下一版。',
  inputSchema: {
    type: 'object',
    properties: {
      added: {
        type: 'array',
        items: { type: 'string' },
        description: '这次实际加的日志位置，例如「L1 src/a.ts:212」',
      },
      collect: CASE_PROPS.collect,
    },
    required: ['added'],
  },
}

/** 执行一次 submit_diagnosis：不是用户报的 Bug 子对话时没有这个工具 */
function callDiagnosis(o: Orchestra, a: Record<string, unknown> | undefined) {
  const r = o.diagnose
    ? o.diagnose(a ?? {})
    : {
        ok: false,
        info: '这里不用交诊断报告：只有用户报的 Bug 子对话要交。按派给你的事直接做。',
      }
  return {
    content: [{ type: 'text', text: r.info }],
    ...(!r.ok && { isError: true }),
  }
}

/** 执行一次 request_logs */
function callRequestLogs(o: Orchestra, a: Record<string, unknown> | undefined) {
  const r = o.requestLogs
    ? o.requestLogs(a ?? {})
    : { ok: false, info: '这里不用请用户复现：只有用户报的 Bug 子对话要。' }
  return {
    content: [{ type: 'text', text: r.info }],
    ...(!r.ok && { isError: true }),
  }
}

/** 执行一次 update_bug_case */
function callBugCase(o: Orchestra, a: Record<string, unknown> | undefined) {
  const r = o.bugCase ? o.bugCase(a ?? {}) : { ok: false, info: '这里没有 Bug 档案：只有用户报的 Bug 子对话要记。' }
  return {
    content: [{ type: 'text', text: r.info }],
    ...(!r.ok && { isError: true }),
  }
}

/** 面板工具注册表的条目：三件都只给用户报的 Bug 子对话（Orchestra.diagnose） */
export const DIAGNOSIS_TOOLS: PanelTool[] = [
  {
    name: DIAGNOSIS_TOOL.name,
    when: (o) => !!o.diagnose,
    def: () => DIAGNOSIS_TOOL,
    hint: (_o, at) =>
      at === 'child'
        ? 'update_bug_case 查的过程中随查随记 Bug 档案（修完也用它记结果）、submit_diagnosis 按阶段交报告（论证、根因、修复方案、验证）、等用户同意再往下、request_logs 加好日志请用户复现、'
        : '',
    call: callDiagnosis,
  },
  { name: BUG_CASE_TOOL.name, when: (o) => !!o.diagnose, def: () => BUG_CASE_TOOL, call: callBugCase },
  { name: REQUEST_LOGS_TOOL.name, when: (o) => !!o.diagnose, def: () => REQUEST_LOGS_TOOL, call: callRequestLogs },
]
