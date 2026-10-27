/**
 * 输入框下面那几个小块的共同样式：上下文、Token、环境、测试记录。
 * 单独放一个文件，免得组件之间为了共用这一行样式互相 import（TaskMeta 与 TestRuns 会互相依赖）
 */
export const META_CHIP =
  'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[0.6875rem] leading-none text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel data-[state=open]:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-subtle'
