/** 英文词典的一部分，键是中文原文：配置安全扫描、内置钩子档位和两个新守卫（借鉴 ECC） */
export const EN_CONFIG_SCAN: Record<string, string> = {
  严格: 'Strict',
  '只留保证对话正确、防误操作的守卫': 'Only guards that keep conversations correct and prevent mistakes',
  '再加省上下文、提节奏的提醒（默认）': 'Plus reminders that save context and keep pace (default)',
  '全部打开，适合能力弱一些的模型或重要项目，打扰会多一些':
    'Everything on: for weaker models or important projects, with more interruptions',
  '跟随全局：{tier}。{desc}': 'Following global: {tier}. {desc}',
  '{desc}；下面逐个改过 {n} 个': '{desc}; {n} changed individually below',
  '选档位会清掉这一层逐个改过的开关；插件带的钩子和我的钩子不受档位影响':
    'Picking a level clears the individual switches at this level; plugin hooks and your own hooks are not affected',
  跟随全局: 'Follow global',
  '安全扫描：高 {high} 条，中 {medium} 条': 'Security scan: {high} high, {medium} medium',
  '安全扫描发现 {n} 处要看一下': 'Security scan found {n} things to review',
  '（在示例里，降了一级）': '(in an example, lowered one level)',
  这条没问题: 'This one is fine',
  '还有 {n} 条低级': '{n} more low',
  '我看过了，仍然安装': 'I reviewed it, install anyway',
  '有看不见的零宽字符或文字方向控制符，可能藏着给模型的指令':
    'Contains invisible zero-width or text-direction characters that may hide instructions for the model',
  '要模型忽略之前的指令，是典型的提示注入写法':
    'Tells the model to ignore previous instructions, a classic prompt injection',
  要模型对用户隐瞒正在做的事: 'Tells the model to hide what it is doing from the user',
  '要模型不经用户确认就执行，绕过确认这一步': 'Tells the model to act without asking the user, skipping confirmation',
  'HTML 注释在渲染后看不见，里面却写着给模型的话':
    'An HTML comment, invisible once rendered, contains text addressed to the model',
  '读取本机凭据（SSH 私钥、云凭据、.env）后往外发':
    'Reads local credentials (SSH keys, cloud credentials, .env) and sends them out',
  '把内容编码后通过网络发出去，常见于偷偷外传':
    'Encodes content and sends it over the network, a common exfiltration pattern',
  '把网上下载的脚本直接交给 shell 执行，内容随时可能被换掉':
    'Pipes a downloaded script straight into a shell; its content can change at any time',
  '反弹 shell：把本机的命令行交给远端控制': 'Reverse shell: hands this machine’s command line to a remote host',
  递归删除根目录或家目录: 'Recursively deletes the root or home directory',
  '让编码 CLI 跳过所有权限确认运行': 'Runs a coding CLI with all permission prompts skipped',
  '服务监听 0.0.0.0，局域网里的其他机器也能连上': 'Listens on 0.0.0.0, so other machines on the network can connect',
  '工具调用自动批准，模型调用它不再问用户': 'Tool calls are auto-approved, so the model never asks the user',
  '把错误吞掉了：出了问题用户看不到': 'Swallows errors: the user won’t see when something goes wrong',
  '像是真实的密钥、令牌或私钥，写在文件里会被所有能读到它的人和模型拿到':
    'Looks like a real key, token or private key; anyone or any model that can read the file gets it',
  '用 npx / uvx 运行没有固定版本的包，每次启动都可能拉到别人新发的代码':
    'Runs an unpinned package with npx / uvx; every start may pull newly published code',
  改之前先看过: 'Read before editing',
  '要改一个已有的文件，这个对话（压缩之后算起）却没读过、没搜到过它时拦一次，让它先看要改的位置；同一个文件再改一次就放行。改文件工具和 sed -i 都算':
    'Blocks once when editing an existing file this conversation has not read or found in a search (since the last compaction), so it looks at the spot first; editing the same file again is allowed. Covers edit tools and sed -i',
  不许改检查配置: "Don't loosen checks",
  '要改 lint、格式化、tsconfig、测试框架这类检查配置时拦一次，让它先改代码、别为了通过去放宽检查；确实要改的说明原因后再改一次就放行':
    'Blocks once when editing lint, formatter, tsconfig or test-framework config, so it fixes the code instead of loosening checks; after explaining why, editing again is allowed',
  另外算检查配置的文件: 'Extra check config files',
  '相对项目根的路径通配，一行一个，例如 scripts/file-caps.json；不带目录的按文件名匹配':
    'Globs relative to the project root, one per line, e.g. scripts/file-caps.json; patterns without a directory match file names',
  '安全扫描（{level}）：{why}（第 {line} 行）': 'Security scan ({level}): {why} (line {line})',
}
