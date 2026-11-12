/**
 * 命令「真正在跑什么」（shared/command-scope.ts）：长命令守卫和后台命令的用途检查都靠它。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backgroundMisuse,
  classifySegment,
  commandKey,
  endlessCommand,
  heavySegment,
  quickSegment,
  runSegments,
  segHead,
  stripHeredocs,
  writesFile,
} from './command-scope.ts'

test('拆段：heredoc / here-string 正文去掉，每段只看程序名，快命令单独认出来', () => {
  assert.equal(stripHeredocs("cat > a.md <<'EOF'\nnpm run test:e2e\nEOF\nnpm test"), 'cat > a.md <<EOF\nnpm test')
  assert.equal(stripHeredocs('cat <<-EOF > a\n  x\n  EOF'), 'cat <<EOF > a')
  assert.deepEqual(runSegments("@'\ngit push\n'@ | Set-Content a.md"), ["@''@", 'Set-Content a.md'])
  // 程序名：跳过环境变量、sudo、路径和 .exe
  assert.equal(segHead('CI=1 FOO="a b" npx playwright test'), 'npx')
  assert.equal(segHead('sudo env X=1 /usr/bin/node a.js'), 'node')
  assert.equal(segHead('"C:\\Program Files\\Git\\bin\\git.exe" status'), 'git')
  assert.equal(segHead('Set-Content a.md'), 'set-content')
  // 快命令：读写文件、查找、git 本地操作算；git clone / fetch、构建工具不算
  for (const s of ['cat a', 'grep -rn x .', 'git status', 'git -C d commit -m x', 'Get-Content a', 'mkdir -p a'])
    assert.ok(quickSegment(s), s)
  for (const s of ['git clone https://x', 'git fetch origin', 'npm run build', 'cargo test', 'sleep 60', 'curl -O x'])
    assert.ok(!quickSegment(s), s)
})

test('后台命令的用途：写文件（heredoc、here-string、内联脚本）和快命令拒收，长命令、搜索、等待放行', () => {
  for (const c of [
    "cat > a.md <<'EOF'\nx\nEOF",
    'cat <<EOF > a.md\nx\nEOF',
    'tee a.md <<EOF\nx\nEOF',
    "@'\nx\n'@ | Set-Content a.md",
    `node -e "require('fs').writeFileSync('a','x')"`,
    `python -c "open('a','w').write('x')"`,
  ])
    assert.ok(writesFile(c), c)
  for (const c of ['npm test > out.log 2>&1', 'cat a.md', 'node scripts/build.mjs']) assert.ok(!writesFile(c), c)
  // 后台命令的用途：写文件、快命令拒收，长命令、搜索、等待、开发服务器放行
  assert.match(backgroundMisuse("cat > a.md <<'EOF'\nnpm run test:e2e\nEOF"), /不用来写文件/)
  assert.match(
    backgroundMisuse("cat > a.md <<'EOF'\nx\nEOF\nnpm run build"),
    /不用来写文件/,
    '写文件和长命令拼在一起也拒',
  )
  assert.match(backgroundMisuse('git status && git diff'), /几秒就能跑完/)
  assert.match(backgroundMisuse('echo hi'), /几秒就能跑完/)
  for (const c of [
    'npm run test:e2e',
    'npm ci\nnpm run build',
    'rg -n foo /big/dir',
    'sleep 300 && gh run view 1',
    'npm run dev',
    'git clone https://x/y.git',
    'npm test > out.log 2>&1',
  ])
    assert.equal(backgroundMisuse(c), '', c)
})

test('不会自己结束的命令：开发服务器、监听算，grep 参数里的 --watch、vite build 不算', () => {
  for (const c of ['npm run dev', 'cd web && npx vite', 'tsc -p . -w', 'node --watch server.ts'])
    assert.ok(endlessCommand(c), c)
  for (const c of ['npx vite build', 'grep -- --watch README.md', 'npm run build']) assert.ok(!endlessCommand(c), c)
})

test('一定要跑几分钟的：UE 编译打包、VS / CMake 整体编译、Docker 构建、整份装依赖算；加一个包、普通 build 脚本不算（用户 2026-11-11 要求重新规划后台命令）', () => {
  for (const c of [
    '"C:/Program Files/Epic Games/UE_5.4/Engine/Build/BatchFiles/Build.bat" MyGameEditor Win64 Development -Project="G:/P/My.uproject"',
    '& "G:\\UE\\Engine\\Build\\BatchFiles\\RunUAT.bat" BuildCookRun -project=G:/P/My.uproject',
    'UnrealEditor-Cmd.exe G:/P/My.uproject -run=ResavePackages',
    'msbuild My.sln /p:Configuration=Release',
    'cmake --build build --config Release',
    'docker compose build',
    'npm ci',
    'npm install',
    'pnpm i --frozen-lockfile',
    'yarn',
    'pip install -r requirements.txt',
    './gradlew assembleRelease',
    'mvn -q package',
  ])
    assert.ok(heavySegment(c), c)
  for (const c of [
    'npm install lodash',
    'yarn add react',
    './build.sh',
    'build',
    'npm run build',
    'cmake -S . -B build',
    'docker ps',
    'pip install requests',
    'cat Engine/Build/BatchFiles/Build.bat',
  ])
    assert.ok(!heavySegment(c), c)
})

test('PowerShell 的 & "带空格的路径" 拆段后程序名不丢：前台的 UE 编译认得出来（用户 2026-11-12 报前台 Build.bat 没被拦）', () => {
  const c =
    '& "D:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat" TPSProjectEditor Win64 Development -Project="C:\\Users\\me\\P\\TPSProject.uproject" -WaitMutex 2>&1 | Select-Object -Last 120; \'===EXIT=\' + $LASTEXITCODE'
  const segs = runSegments(c)
  assert.equal(segHead(segs[0]), 'build')
  assert.ok(heavySegment(segs[0]), segs[0])
  // 拆段切开的半边引号照旧去掉
  assert.deepEqual(runSegments('bash -lc "npm test && npm run e2e"'), ['npm test', 'npm run e2e'])
})

test('命令按实测用时归档的名字：程序名加前两个非选项参数；快命令没有名字', () => {
  assert.equal(commandKey('npm run build -- --mode demo'), 'npm run build')
  assert.equal(commandKey('cargo build --release'), 'cargo build')
  assert.equal(commandKey('node scripts\\x.mjs --fast 2>&1'), 'node scripts/x.mjs')
  assert.equal(commandKey('& "C:\\Tools\\gen.exe" A'), 'gen a')
  assert.equal(commandKey('cat a.txt'), '')
})

test('一段命令该在哪跑只判定一处：快命令、常驻服务、一定很久、完整检查、实测慢、看项目', () => {
  const o = { suite: /\be2e\b/, extra: ['make all'], slowMs: (s: string) => (s === 'tsc -b' ? 70_000 : undefined) }
  assert.equal(classifySegment('cat a', o).kind, 'quick')
  assert.equal(classifySegment('npm run dev', o).kind, 'service')
  assert.equal(classifySegment('npm ci', o).kind, 'heavy')
  assert.equal(classifySegment('npm run e2e', o).kind, 'suite')
  assert.equal(classifySegment('make all', o).kind, 'suite')
  assert.deepEqual(classifySegment('tsc -b', o), { kind: 'slow', ms: 70_000 })
  assert.equal(classifySegment('npm run build', o).kind, 'other')
})
