# server · 技能库的多文件管理

[server 模块](README.md)的子页面：`server/library.ts` 的多文件接口、路径安全、软链接、大小和树上限。模块的状态块、`server/tasks.ts` 拆分表、入口、依赖和回归验证见 [README.md](README.md)，Bug 记录见 [bugs.md](bugs.md)。

2026-10-31 从 `README.md` 原样挪出（文字没改），各条的日期和结论以当时为准。

## 技能库的多文件管理

`server/library.ts` 除主文件（Skill 的 `SKILL.md`、命令的 `.md` / `.toml`）外，还能单独读写一个 Skill 目录里的附带文件。前端的文件树、编辑、改名、删除都走这里，契约在 `shared/library.ts`。

**数据结构**：`LibraryFile` 是 `{ content, files, tree? }`。`content` 是主文件内容；`files` 保持旧语义（`tree.entries` 里 `type === 'file'` 的 path 扁平列表，前端老代码照旧能用）；`tree` 是 `{ entries, truncated? }`，`entries` 是 `{ path, type: 'file' | 'dir', size? }` 的扁平列表——**目录和文件混在一张表里**，路径统一用 `/`，前端按 `/` 分段就能画出树。排序约定：**同一层目录在前、再按名字排**，并且用广度优先展开，所以父目录一定排在子项前面，截断时留下的也是浅层。命令（`kind: 'command'`）没有附带目录结构，`tree` 是 `undefined`、`files` 是 `[]`。

**接口**（都在 `libraryApi()` 里，错误统一 `400` + `{ error }` 文案）：

| 方法   | 路径                    | 参数                                                         | 返回                                               |
| ------ | ----------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| GET    | `/library/file`         | `cli` / `kind` / `name`                                      | `LibraryFile`                                      |
| GET    | `/library/entry`        | `cli` / `kind` / `name` / `path`                             | `{ path, exists, binary?, content, size, mtime? }` |
| PUT    | `/library/entry`        | body：`cli` / `kind` / `name` / `path` / `content`           | `{ path, bytes }`                                  |
| DELETE | `/library/entry`        | `cli` / `kind` / `name` / `path`                             | `{ path, deleted }`                                |
| POST   | `/library/entry/rename` | body：`cli` / `kind` / `name` / `from` / `to` / `overwrite?` | `{ from, to }`                                     |

路径都放在 query 和 body 里、不拼进 URL，所以 `..` 不会在路由层被 normalize 掉，全交给下面那道校验判断。读一个还不存在的文件不报错，返回 `exists: false`（新建前先看一眼很方便）。

**路径安全**（`shared/library.ts` 的 `libraryEntryPath` + `server/library.ts` 的 `entryOf`，两道关）：

1. 字符串层：`..`、`.`、空段、绝对路径、盘符（`C:`）、`\0` 和 Windows 非法字符（`< > : " | ? *`）一律拒绝；反斜杠统一当 `/`，末尾斜杠去掉。
2. 真实路径层：把路径拼到 `realpath(Skill 目录)` 上，再对「已存在的那一段」`realpath` 一次，确认它仍在 Skill 目录里（`insideDir`）。只靠第 1 道挡不住软链接——Skill 目录里放一个指向外面的目录链接，`link/secret.txt` 字符串上完全合法。找「已存在的那一段」用的是 **`lstat`**：`existsSync` 会跟随软链接，断链时报「不存在」而一路退到 Skill 目录本身，校验就放行了，真正写的时候 OS 会把链接解开、在目录外创建文件。`realpath` 失败（断链、`EACCES`）**直接拒绝**，不回退成字符串路径。

**软链接**：Skill 目录本身是链接时，附件的读写落到**链接指向的真实目录**（`skillRootOf` 先 `realpath`），删文件不动原文件夹——和 `deleteLibrary` 只删链接的约定一致。

Skill 目录**里面**的软链接按「看得见、删得掉、改不了」处理，读、写、删、树四处口径一致：

- 树里标成 `type: 'link'`（不是 `file`，也不给 `size`），不跟进去（可能是链到外面的大目录）；`files` 只放普通文件，不含链接。
- 读接口返回 `{ exists: true, link: true, content: '', size: 0 }`——**不给内容**：链接的目标可能是目录、可能在 Skill 目录外，给一份前端改完又存不回去的正文只会让人困惑。
- 写接口拒绝，文案「这是个链接，不能直接改内容」（不是「路径不合法」，用户能据此知道该去改目标文件）。
- 删接口删的是链接本身，不动目标：链接（文件链接、目录链接、junction）统一走 `rm`——Node 的 `rm` 对链接只删链接本身、不跟进，而且 Windows 上删目录重解析点**不能**走 `unlink`（`DeleteFile` 会报 `EPERM`，必须让 rmdir 系来删）。

**路径校验只校验父目录**（`entryOf`）：把「最后一段的父目录」`realpath` 后要求仍在 Skill 目录内，拦住 `link/secret.txt` 这种穿过软链接目录的访问；最后一段本身是不是链接，交给各操作按 `lstat` 自己决定。最后一段也一起 `realpath` 的话，树里列出来的链接一读就报「路径不合法」，和上面那条口径打架。`realpath` 失败（断链、`EACCES`）**直接拒绝**，不回退成字符串路径——否则一条断链的软链接就能让写入落到目录外。

**二进制与大小**：单个附带文件上限 `LIBRARY_FILE_MAX_BYTES`（1 MiB），读写超限都直接报错、不截断。报错文案按 `LIBRARY_FILE_MAX_KIB`（1024 KB）说，和前端「1.0 MB」的显示口径一致——用 1048 KB 会和 MB 那条自相矛盾。链接和目录的判断放在大小检查**之前**：一个超限的链接该说「这是个链接」，不该让人以为要去删内容。二进制靠「头部有 `\0` 字节」判定（和 `server/files.ts` 的 `readInDir` 一致）：大多数图片、压缩包、可执行文件都带 `\0`，比按扩展名白名单稳（无扩展名的文本不会误判），也不依赖 UTF-8 解码是否报错（非法 UTF-8 会被静默替换成 U+FFFD，判不出来）。命中时返回 `binary: true`、`content: ''`，**`size` 照常返回**（前端要显示「二进制文件，{kb} KB」）。误请求一个目录时返回 `size: 0`，不把目录的元数据大小（64 / 4096 这类）当成文件大小。

**文件树上限**：`LIBRARY_TREE_MAX_ENTRIES`（1000 项，**目录也算一项**），超过就截断并在 `tree.truncated` 标出来。排除规则分两张表：`LIBRARY_TREE_EXCLUDE_DIRS`（依赖和版本库目录：`node_modules`、`.git`、`.svn`、`__pycache__`、`.venv`、`venv`）**只对目录生效**，`LIBRARY_TREE_EXCLUDE_FILES`（`.DS_Store`、`Thumbs.db`）**只对文件生效**。不拿搜索用的 `DEFAULT_SEARCH_EXCLUDE`：那份清单的语义是「搜代码时跳过的噪音目录」，会把技能里真放内容、刚好叫 `logs` / `build` / `out` 的目录一起抹掉。主文件 `SKILL.md` 不进树（大小写无关判，`skill.md` 也算它），它单独用 `content` 返回。

**删目录与改名**：删目录是递归删，但先用 `countEntries` 数一遍，超过 `LIBRARY_DIR_MAX_DELETE_ENTRIES` 就拒绝（让用户先清掉里面的文件），数条目时不跟进软链接。改名默认 `overwrite: false`，目标已存在报「「{name}」已经有了」；目录不能并进已存在的目录（单独一条文案），也不许把目录移到它自己里面。覆盖时**不先删目标再 rename**：先把目标挪到 `.old-<pid>-<时间戳>` 留底，rename 成功再删留底，失败就把留底改回去，否则 rename / mkdir 任一步失败（Windows 上目标被占用很常见）旧内容就找不回来了；回滚本身也失败时，错误文案带上留底文件名，让用户能自己找回来。源和目标是不是同一个文件用 `sameFile` 判——比 `dev` + `ino`（真实文件身份），**不按字符串小写归一**：小写归一会把 Linux 上 `Notes.md → notes.md` 这种合法改名当成同一文件、返回成功却什么都没做。只差大小写的改名走「先改到临时名、再改到目标」两步，真把名字换掉，也不会在覆盖分支里删掉源文件；第二步失败时把名字改回去，回滚也失败就用「改名失败，原内容留在 {name}」把临时文件名告诉用户，不让文件「改名成功一半」。

**主文件保护**：`entryOf` 用 `rel.toLowerCase() === 'skill.md'` 判（主文件不许走附件接口），文件树也同样大小写无关——NTFS / APFS 不区分大小写，只比大写会让人用 `skill.md` 覆盖或删掉 `SKILL.md`。

**回归**：`server/library.test.ts`（文件树排序与截断、`files` 与 `tree` 一致、路径穿越各种写法、软链接越界与软链接 Skill 的读写落点、二进制识别、读写超限、增删改往返、目录删除上限、命令没有附件）、`server/project-skills.test.ts`（项目技能的 `files` / `tree` 两个字段一致）、`npm run test:e2e` 里「Skills / 命令库」那段（附件写读改删和路径穿越）。
