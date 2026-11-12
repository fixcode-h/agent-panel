/**
 * 面板的后台命令工具（run_background / check_background / stop_background）：定义、用法说明和调用都在这里，
 * 作为面板工具注册表（server/panel-tools/registry.ts）的条目。
 *
 * 用途限定（用户 2026-11-05 定）：后台命令只给要跑很久的命令——编译、测试、打包、安装依赖、下载，
 * 以及不会自己结束的开发服务器、监听（service）。写文件、几秒就完的命令不收（shared/command-scope.ts 的 backgroundMisuse），
 * 命令先过和 CLI 命令工具同一套守卫（Orchestra.guardCommand，见 server/hooks/dispatch.ts 的 commandGuard）
 */
import type { Orchestra } from '../shared/engine-host.ts'
import { backgroundMisuse, endlessCommand } from '../shared/command-scope.ts'
import { shellNote } from '../shared/shells.ts'
import { lastShell } from './shells.ts'
import { stepField } from './orch-fields.ts'
import { reply, str, text, type PanelTool, type ToolArgs } from './panel-tools/types.ts'

/** 后台命令在哪个 shell 里跑（设置里的命令行环境），Agent 按它的语法写命令 */
const shellHint = () => {
  const sh = lastShell()
  return sh ? shellNote(sh) : ''
}

/** run_background 在用法说明里那一句的主体：Chat 页另外补上查看、停止的两个工具 */
const RUN_BG_HINT =
  'run_background 只把要跑很久的命令（UE / C++ 编译打包、完整测试、整份装依赖、下载、扫整个项目的全文搜索）和开发服务器、监听（service）放到后台（跑完结果自动推回），写文件、几秒的命令不交给它'

export const BACKGROUND_TOOLS: PanelTool[] = [
  {
    name: 'run_background',
    when: (o) => o.canBackground,
    hint: (_o, at) =>
      at === 'chat'
        ? `${RUN_BG_HINT}，check_background / stop_background 查看、停止它们；`
        : at === 'conv'
          ? `${RUN_BG_HINT}；`
          : '',
    call: (o, a) => callRunBackground(o, a),
    def: (o) => ({
      name: 'run_background',
      title: '后台命令',
      description:
        '只用于要跑很久的命令：完整测试、编译、打包、安装依赖、下载，以及开发服务器、监听这类不会自己结束的进程（service 设为 true）。交给面板在后台跑，马上返回编号，跑完结果自动推回给你；等待期间不要改这条命令要检查的文件。' +
        '不要用它写文件（用你自己的编辑工具）、不要用它跑几秒就完的命令（直接用你自己的命令工具）：这两种面板会拒收。' +
        // UE 编译也从这里交：面板按编译目录占位排队，子对话的转成向父对话的申请（后台命令重新设计 2026-11-12）
        'UE 项目的编译（Build.bat、UBT、RunUAT）也交给它：面板按编译目录占位排队，子对话交来的会转成向父对话的编译申请。' +
        // 子任务的结果推回的是派它的对话（它自己已结束），要让模型知道这件事，不要以为能在这里等结果
        (o.helper ? '你是子任务：结果推回派你的对话，并标注是哪个子任务起的，你启动后接着做别的事或结束这一轮。' : '') +
        shellHint(),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令原文' },
          name: { type: 'string', description: '给这条命令起个短名字，例如「端到端测试」' },
          cwd: { type: 'string', description: '相对当前目录的工作目录，不写就是当前目录' },
          exclusive: {
            type: 'boolean',
            description: '编译、打包这类会抢文件锁的命令设为 true：按项目排队，同一时间只跑一个',
          },
          service: {
            type: 'boolean',
            description:
              '开发服务器、监听这类一直跑到被停掉的进程设为 true：面板不催、不按「等结果」挂计划，对话停止或用 stop_background 时停掉它；中途退出了会把结果推回。启动后用 check_background 看输出确认它起来了（端口、地址）',
          },
          timeout_minutes: {
            type: 'number',
            description:
              '最多跑多少分钟，到点面板停掉它并把结果推回；按命令正常要多久写宽一些，不写默认 120（service 默认 480），最多 480',
          },
          ...(o.plans ? { step: stepField('这条命令') } : {}),
        },
        required: ['command'],
      },
    }),
  },
  {
    name: 'check_background',
    when: (o) => o.canBackground,
    def: () => ({
      name: 'check_background',
      title: '查看后台命令',
      description:
        '查后台命令的状态、已经跑了多久、多久没输出和最近的输出；不写 id 列出这个对话的全部。结果会自动推回来，不需要轮询；开发服务器（service）启动后用它看地址和报错。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    }),
    call: (o, a) => text(o.checkBackground(str(a?.id))),
  },
  {
    name: 'stop_background',
    when: (o) => o.canBackground,
    def: () => ({
      name: 'stop_background',
      title: '停止后台命令',
      description:
        '停掉这个对话的一条后台命令：确认它卡住了（长时间没输出、跑偏了）、或者开发服务器 / 监听用完了才用；卡住的停掉后查清原因再重跑。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }),
    call: (o, a) => reply(o.stopBackground(str(a?.id))),
  },
]

/** run_background：先看用途、再过守卫，然后交给面板在后台跑 */
async function callRunBackground(o: Orchestra, a: ToolArgs) {
  const command = str(a?.command).trim()
  if (!command) return text('command 是空的：写要执行的命令', true)
  // 先看用途、再过守卫：写文件、快命令的拒绝理由更直接；守卫的拒绝和 CLI 命令工具上的一字不差
  const misuse = backgroundMisuse(command)
  if (misuse) return text(`【面板】${misuse}`, true)
  const deny = (await o.guardCommand?.(command)) ?? ''
  if (deny) return text(deny, true)
  const r = await o.runBackground({
    command,
    // 没给名字时用命令第一行：名字会写进推回结果的标题（界面按第一行显示），带换行会把「成功 / 失败」截掉
    name: str(a?.name).trim() || command.split('\n')[0].trim().slice(0, 40),
    cwd: str(a?.cwd).trim(),
    exclusive: a?.exclusive === true,
    // 开发服务器、监听这类不会自己结束的：没写 service 也按常驻服务跑，不然十分钟没输出就催、两小时被停、计划一直等
    ...((a?.service === true || endlessCommand(command)) && { service: true }),
    ...(Number(a?.timeout_minutes) > 0 && { timeoutMinutes: Number(a?.timeout_minutes) }),
    step: str(a?.step).trim(),
  })
  return reply(r)
}
