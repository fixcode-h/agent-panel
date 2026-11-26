/** 英文词典的一部分，键是中文原文：面板要用的本机程序没装时输入框上方的安装卡片（shared/local-programs、server/local-programs） */
export const EN_LOCAL_PROGRAMS: Record<string, string> = {
  '本机没装 {name}': '{name} is not installed on this computer',
  '正在安装：{step}': 'Installing: {step}',
  '也可以在终端里自己装，装好后不用重启面板：':
    'You can also install it yourself in a terminal; no need to restart the panel afterwards:',
  '这台电脑上找不到能自动安装的包管理器，请在终端里手动装，装好后不用重启面板：':
    'No package manager for automatic installation was found on this computer. Install it in a terminal; no need to restart the panel afterwards:',
  'find 按文本找要用它一次查全；没装时只能逐个读文件，大项目里慢，还可能查不全。':
    'find uses it to search text across the whole project at once. Without it, files are read one by one, which is slow in large projects and may miss matches.',
  没有这个程序: 'No such program',
  安装已取消: 'Installation canceled',
}
