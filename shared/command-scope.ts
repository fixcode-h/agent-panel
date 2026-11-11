/**
 * 一条 shell 命令「真正在跑什么」：守卫和后台命令的用途检查都按它判断，不按命令原文里出现的字样。
 *
 * 以前长命令守卫（server/hooks/guards.ts 的 longDeny）把命令按换行切段后，只要哪一段里有 e2e、test:unit、--watch，
 * 就拦下并让 Agent「改用 run_background」：heredoc 写一份提到 `npm run test:e2e` 的文档、`git commit -m '修复 e2e'`、
 * `grep -rn e2e scripts`、`cat scripts/e2e/x.mjs` 全被拦，Agent 照着提示把写文件、查文件都交给了后台命令
 * （用户 2026-11-05 报「写文件命令怎么也用后台命令了」）。这里统一三件事：
 * - heredoc / PowerShell here-string 的正文是数据，不是命令，切段前去掉；
 * - 每段只看开头的程序名（跳过环境变量赋值、sudo、env、time 这类前缀）；
 * - 几秒就完的「快命令」（读写文件、查找、git 的本地操作）单独列出来：长命令守卫不管它们，后台命令拒收它们。
 */
import { commandSegments } from './hook-defs.ts'
import { unwrapShell } from './shell-command.ts'

/**
 * 去掉 heredoc（`<<EOF` / `<<-'EOF'` / `<<"EOF"`）和 PowerShell here-string（`@' … '@`、`@" … "@`）的正文，
 * 只留起头那一行。正文里写的是要写进文件或喂给程序的内容，里面出现「npm run test:e2e」「git push」不代表要跑它们
 */
export function stripHeredocs(cmd: string): string {
  return cmd
    .replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, '<<$2$3')
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "@''@")
}

/** 按段拆开、去掉 heredoc 正文后的命令段（外壳 cmd /c、bash -lc 这类先剥掉） */
export function runSegments(cmd: string): string[] {
  return commandSegments(stripHeredocs(unwrapShell(cmd)))
}

/** 一段命令前面不算「程序」的部分：环境变量赋值、sudo / env / time / nohup / command 这类转手的前缀 */
const PREFIX = /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+|(?:sudo|env|time|nohup|command|exec|builtin)\s+)+/

/** 一段命令真正运行的程序名：小写、去掉路径和 .exe / .cmd / .ps1 后缀；PowerShell 的 cmdlet 原样小写 */
export function segHead(seg: string): string {
  const s = seg.trim().replace(PREFIX, '')
  const first = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(s)
  const word = first ? (first[1] ?? first[2] ?? first[3]) : ''
  return (
    word
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.(exe|cmd|bat|ps1)$/, '') ?? ''
  )
}

/** 段里程序后面的部分（参数），用来区分 `git status` 和 `git clone` 这类同一程序的快慢子命令 */
const segArgs = (seg: string) =>
  seg
    .trim()
    .replace(PREFIX, '')
    .replace(/^("[^"]+"|'[^']+'|\S+)\s*/, '')

/**
 * 几秒就跑完的命令：读写文件、列目录、查找、文本处理、输出。长命令守卫不拦它们（参数里出现 e2e 不代表在跑 e2e），
 * 后台命令也不收它们（交给后台只会多一轮推送，写文件还绕开了 CLI 自己的编辑工具和面板的改文件守卫）
 */
const QUICK = new Set([
  // 读写、列文件
  'cat',
  'type',
  'echo',
  'printf',
  'tee',
  'touch',
  'mkdir',
  'md',
  'rmdir',
  'cp',
  'copy',
  'mv',
  'move',
  'ren',
  'rename',
  'rm',
  'del',
  'erase',
  'ln',
  'chmod',
  'chown',
  'ls',
  'dir',
  'tree',
  'pwd',
  'cd',
  'pushd',
  'popd',
  'stat',
  'file',
  'realpath',
  'dirname',
  'basename',
  'readlink',
  'which',
  'where',
  'whoami',
  'hostname',
  'date',
  'true',
  'false',
  ':',
  // 查找和文本处理
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'find',
  'fd',
  'findstr',
  'sed',
  'awk',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'cmp',
  'comm',
  'jq',
  'xargs',
  'less',
  'more',
  'column',
  'nl',
  'od',
  'xxd',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'base64',
  'test',
  '[',
  // PowerShell 的读写文件、查找
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'copy-item',
  'move-item',
  'remove-item',
  'rename-item',
  'get-content',
  'get-childitem',
  'get-item',
  'test-path',
  'write-output',
  'write-host',
  'select-string',
  'get-location',
  'set-location',
  'resolve-path',
  'join-path',
  'split-path',
  'gc',
  'gci',
  'sc',
  'ac',
  'ni',
  'cpi',
  'mi',
  'ri',
  'sls',
])

/** git 里可能跑很久的子命令（要联网或者扫大仓库）；其余（status、diff、log、add、commit、checkout……）都算快命令 */
const SLOW_GIT = /^(?:-[cC]\s+\S+\s+)*(?:clone|fetch|pull|push|lfs|submodule|gc|fsck|repack|bisect\s+run|svn|p4)\b/

/**
 * 搜索类：一般几秒就完（长命令守卫不拦），可扫大范围时确实会跑上几分钟（skills/project/project-structure 让它放后台），
 * 所以后台命令收它们
 */
const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'findstr', 'select-string', 'sls', 'xargs'])

/** 这一段是几秒就跑完的快命令 */
export function quickSegment(seg: string): boolean {
  const head = segHead(seg)
  if (!head) return true
  if (head === 'git') return !SLOW_GIT.test(segArgs(seg))
  return QUICK.has(head)
}

/** 写文件的写法：重定向 heredoc / here-string、PowerShell 写文件的 cmdlet、内联脚本里的写文件 API */
const WRITE_FILE = [
  // cat > a.md <<'EOF'、cat <<EOF > a.md、tee a.md <<EOF
  /(?:>>?\s*[^\s&|;<>]+[^\n]*<<-?\s*['"]?\w|<<-?\s*['"]?\w+['"]?[^\n]*>>?\s*[^\s&|;]+|\btee\b[^\n]*<<)/,
  // @' … '@ | Set-Content a.md
  /@['"]\r?\n[\s\S]*?\r?\n['"]@\s*\|\s*(?:set-content|add-content|out-file|sc|ac)\b/i,
  // node -e "fs.writeFileSync(…)"、python -c "open(…, 'w')"
  /\b(?:node|bun|deno|python3?|py)\s+(?:-\w+\s+)*-[ec]\s[\s\S]*(?:writeFile(?:Sync)?|appendFile(?:Sync)?|open\([^)]*['"][wa]b?\+?['"]|write_text|write_bytes)/i,
]

/** 这条命令是在写文件 */
export function writesFile(cmd: string): boolean {
  const s = unwrapShell(cmd)
  return WRITE_FILE.some((re) => re.test(s))
}

/**
 * 交给后台命令的这条命令合不合用途：后台命令只收要跑很久的（编译、测试、打包、安装依赖、下载、开发服务器、监听、等外部结果）。
 * 写文件、几秒就完的快命令拒收并说明该怎么做；合用途返回空串
 */
export function backgroundMisuse(cmd: string): string {
  if (writesFile(cmd))
    return '后台命令不用来写文件：新建、修改文件用你自己（CLI 自带）的编辑 / 写文件工具，面板才能记下改了哪些文件、按规则检查；写好之后要跑的长命令（编译、测试）再交给 run_background。'
  const segs = runSegments(cmd)
  if (segs.length && segs.every((x) => quickSegment(x) && !SEARCH.has(segHead(x))))
    return '后台命令只用于要跑很久的命令（编译、测试、打包、安装依赖、下载、开发服务器、监听）：这条命令几秒就能跑完，直接用你自己（CLI 自带）的命令工具执行；写文件用编辑工具。'
  return ''
}

/**
 * 一定要跑几分钟的编译、打包、装依赖（用户 2026-11-11 要求重新规划哪些命令走后台）：放在前台会撞上命令工具的两分钟超时、
 * 被杀掉还拿不到结果，执行中用户发的消息也要等它。只列「几乎总是很久」的：UE 的编译、打包、命令行编辑器，
 * Visual Studio / CMake 的整体编译，Docker 构建，按锁文件整份安装依赖，Gradle / Maven 打包。
 * npm run build、tsc、cargo build、加一个包的 npm install 这类时长看项目的不在这里（几秒就完的也推到后台只会多一轮），
 * 项目里确实很慢的由用户在长命令守卫的「另外算长命令的命令前缀」里补
 */
const HEAVY_PROGRAMS = new Set([
  // UE：RunUAT（打包、Cook）、UBT、命令行编辑器（Commandlet、自动化测试）；Engine/Build/BatchFiles/Build.bat 在下面单独认
  'runuat',
  'unrealbuildtool',
  'ubt',
  'unrealeditor-cmd',
  'ue4editor-cmd',
  // Visual Studio 的整体编译
  'msbuild',
  'devenv',
])

/** 同一程序里慢的那几种用法（看参数）：整份装依赖只认不带包名的 install / ci，npm install foo 只加一个包不算 */
const WHOLE_INSTALL = /^(?:ci|i|install)(?:\s+-\S+)*\s*$/
const HEAVY_ARGS: Record<string, RegExp> = {
  cmake: /^--build\b/,
  docker: /^(?:compose\s+)?(?:build|pull)\b/,
  'docker-compose': /^(?:build|pull)\b/,
  npm: WHOLE_INSTALL,
  pnpm: WHOLE_INSTALL,
  bun: WHOLE_INSTALL,
  yarn: /^(?:install)?(?:\s+-\S+)*\s*$/,
  pip: /^install\s+(?:.*\s)?-r\s/,
  pip3: /^install\s+(?:.*\s)?-r\s/,
  python: /^-m\s+pip\s+install\s+(?:.*\s)?-r\s/,
  python3: /^-m\s+pip\s+install\s+(?:.*\s)?-r\s/,
  poetry: /^install\b/,
  bundle: /^install\b/,
  gradle: /(?:^|\s)(?:build|assemble\w*|bundle\w*)\b/,
  gradlew: /(?:^|\s)(?:build|assemble\w*|bundle\w*)\b/,
  mvn: /(?:^|\s)(?:package|install|verify)\b/,
  mvnw: /(?:^|\s)(?:package|install|verify)\b/,
}

/** 这一段是一定要跑几分钟的编译、打包、装依赖；按段开头真正运行的程序判断（PowerShell 的 & "路径" 调用先剥掉 &） */
export function heavySegment(seg: string): boolean {
  const s = seg.trim().replace(/^&\s*/, '')
  // 拆段时带引号的路径可能只剩后半个引号（G:/…/Build.bat" 参数），先去掉再去后缀
  const head = segHead(s)
    .replace(/["']+$/, '')
    .replace(/\.(?:exe|cmd|bat|ps1|sh|command|com)$/, '')
  if (HEAVY_PROGRAMS.has(head)) return true
  // UE 的 Build.bat 名字太普通：只认 Engine/Build/BatchFiles 下的那个
  if (head === 'build' && /batchfiles[\\/]+build/i.test(s)) return true
  const args = HEAVY_ARGS[head]
  return !!args && args.test(segArgs(s))
}

/** 不会自己结束的命令（开发服务器、监听）：放在前台会一直挡着对话，交给后台时按常驻服务（service）跑 */
const ENDLESS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b/,
  /^(?:npx\s+)?vite(?:\s+(?!build\b|preview\b)\S|$)/,
  /^(?:npx\s+)?(?:nodemon|http-server|live-server)\b/,
  /\s--watch\b/,
  /^(?:npx\s+)?tsc\b.*\s-w\b/,
]

/** 这一段是不会自己结束的命令：快命令（参数里写着 --watch 的 grep、git commit）不算 */
export const endlessSegment = (seg: string) => !quickSegment(seg) && ENDLESS.some((re) => re.test(seg))

/** 整条命令里有不会自己结束的那一段 */
export const endlessCommand = (cmd: string) => runSegments(cmd).some(endlessSegment)
