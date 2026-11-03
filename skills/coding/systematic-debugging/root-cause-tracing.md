# 沿调用链往回追根因

错误常常出在调用栈很深的地方（在错的目录里 `git init`、文件建在了错的位置、用错的路径打开数据库）。在报错的地方改是修症状，要沿调用链往回追，找到坏值第一次出现的地方，在那里修。

## 什么时候用

- 报错发生在执行的深处，不在入口；
- 堆栈很长，看不出坏值是从哪来的；
- 要找出是哪个测试、哪段代码触发了问题。

往回追到头也找不到来源（例如值来自外部输入）时，才在出错点附近修，并在报告里写明追到了哪里、为什么停在那。

## 怎么追

1. **看现象**：`Error: git init failed in ~/project/packages/core`。
2. **找直接原因**：哪行代码直接导致的？`await execFileAsync('git', ['init'], { cwd: projectDir })`。
3. **问谁调用了它**：一跳一行写下来（和完整流程里的调用栈同一个写法）：

   ```text
   WorktreeManager.createSessionWorktree(projectDir, sessionId)
     ← Session.initializeWorkspace()
     ← Session.create()
     ← 测试里的 Project.create()
   ```

4. **看传进来的是什么值**：`projectDir = ''`；空字符串当 `cwd` 会落到 `process.cwd()`，也就是源码目录。
5. **找到最初的触发点**：`setupCoreTest()` 返回 `{ tempDir: '' }`，测试在 `beforeEach` 之前就读了它。修这里，不修 `git init`。

## 手工追不动时加堆栈

在出问题的操作前打一条带堆栈的临时日志（前缀照完整流程的 `[排查-<主题>]`，修完删掉）：

```typescript
async function gitInit(directory: string) {
  console.error('[排查-gitinit]', { directory, cwd: process.cwd(), stack: new Error().stack })
  await execFileAsync('git', ['init'], { cwd: directory })
}
```

测试里用 `console.error`（日志库的输出可能被吞掉），跑完 `npm test 2>&1 | grep '\[排查-gitinit\]'`，看堆栈里的测试文件名和行号、是不是同一个测试或同一个参数。

## 找出是哪个测试污染了状态

跑测试时冒出不该有的文件或状态、又不知道是哪个测试干的：用同目录的 `find-polluter.sh` 逐个跑测试，停在第一个造成污染的：

```bash
./find-polluter.sh '.git' 'src/**/*.test.ts'
```

## 修完之后

在源头修好以后，再看要不要按 `defense-in-depth.md` 在数据经过的其他层加校验，让同类问题在别的入口也进不来。加校验不能代替在源头修。
