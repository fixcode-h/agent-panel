---
paths: server/exec/worktree.ts, server/exec/git.ts, server/turn-changes.test.ts
---

# Windows 上的路径和换行

## 拿路径去比 git 注册表前先解析成真实路径

- 规则：和 `git worktree list` 的输出比路径时两边都过 `realNorm`（`realpath` 后再 `normPath`），不能只 `path.resolve`：git 记的是真实长路径，面板手里的可能是 Windows 8.3 短名（`RUNNER~1`）或经过符号链接（macOS `/var` → `/private/var`）。对不上时在用的工作区会被当成「注册表外的残留」整个删掉，包括没收口的任务。
- 起因：6458a042 加了 Windows 单测后，「守护清理：任务没收口的不碰」在 Windows 上把注册表里的 `pending1` 当残留清了。
- 防线：`server/exec/worktree.test.ts` 的「守护清理」用例（Windows CI 的临时目录就是短名；Linux 上用指向符号链接的 `TMPDIR` 跑能复现）。

## 工作区文件和 git 里的内容比，只差换行不算改过

- 规则：`git cat-file --filters` 按 autocrlf 取出来是 CRLF，Agent / 用户写的常是 LF。撤销这类「工作区内容 vs 快照内容」的比较用 `sameText`（忽略 CRLF/LF），三方合并前统一成 LF，写回时按工作区原来的换行风格（`eolLike`），不顺手把整个文件的换行换掉。
- 起因：6458a042 加了 Windows 单测后，`server/turn-changes.test.ts` 里三条撤销用例全挂（Windows 上 Git 默认 `core.autocrlf=true`），真实用户在 Windows 上撤销 LF 写的文件也会误报「后来又被改过」。
- 防线：`server/turn-changes.test.ts`；Linux 上用 `HOME` 指向一个写了 `core.autocrlf = true` 的 `.gitconfig` 跑能复现。
