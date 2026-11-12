# 诊断报告「修复」一步把改过的文件整个画成新增

- 状态：已修复（`shared/bug/fix.test.ts`、`server/exec/bug-source.test.ts` 回归）
- 症状：Bug 诊断报告走到「修复」，改动的代码里 C++、Lua 文件从第 1 行到最后一行全是绿色新增，看不出到底改了哪几行
- 入口：交 `phase: fix` 时 `shared/bug/diagnosis.ts` 调 `fixFilesOf`（`shared/bug/fix.ts`），每个文件的 diff 由 `server/exec/bug-source.ts` 的 `diff` 取
- 根因类型：取不到基线时退回「和空文件比」
- 模块：`shared`（`shared/bug/fix.ts`），配套 `server/exec/bug-source.ts`
- 关键词：修复、fixFiles、diff、整个文件新增、P4、Perforce、SVN、不是 git、git diff --no-index、/dev/null

## 根因

`bugSource().diff` 先和对话开始时的提交比；比出来是空、且 `git ls-files --error-unmatch` 不认这个文件，就当成「没跟踪的新文件」，
用 `git diff --no-index /dev/null <文件>` 和空文件比。不是 git 工作区的工程（UE 项目常见的 P4、SVN）里拿不到 HEAD，
第一步什么也比不出来，`ls-files` 也必然失败，于是每个改过的文件都走到和空文件比，整个文件都是 `+`。

## 修法

`diff` 先确认目录是 git 工作区，不是就返回 undefined（取不到），不再和空文件比。
`fixFilesOf` 取不到 diff 时改用 `editPatch`：拼这个对话里改这个文件的工具调用记下的改动（CLI 给出结果后是带行号的 diff，
和对话里点开改动文件看到的是同一份），失败的调用和不是 diff 的输入不要。两边都取不到的文件计入 `blind`，
不把「一个文件都没取到」当成「还没改代码」退回。
