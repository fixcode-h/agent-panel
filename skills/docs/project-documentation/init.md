# 项目文档管理 · 初始化

入口 `SKILL.md` 指到这里时读：用户明确要「初始化文档结构」或「初始化项目」时。骨架在同目录 `templates.md`。

## 初始化

明确要「初始化文档结构」或「初始化项目」时执行。先读项目，后写文档；不对整个源码树做全文搜索。

1. **确定两个根**：按路径模型确定 `PROJECT_ROOT` 和 `DOC_ROOT`；P4 项目的文档不写回项目目录。
2. **读项目**：已有的 AGENTS.md / CLAUDE.md / README / 文档目录；依赖清单和构建配置（package.json、Cargo.toml、go.mod、_.uproject、_.sln、CMakeLists.txt 等）；scripts、Makefile、CI 配置；格式和检查配置（.editorconfig、Prettier、ESLint、clang-format 等）；一级和二级目录；Git 项目再看最近 20 条提交说明，了解提交约定。
3. **AGENTS.md**：不存在就按 `templates.md` 的骨架新建；已存在就保留原有内容和结构，只补缺的段落（常用命令、目录速览、文档地图等），修正和项目实际不符的命令和路径。命令必须是项目里真实存在的，不编 `npm run xxx`。
4. **CLAUDE.md**：不存在时新建，只写一行 `@AGENTS.md`；已存在但没引用 AGENTS.md 时在末尾追加一行 `@AGENTS.md`；已有内容不删。
5. **DOC_ROOT/README.md**：按 `templates.md` 写；已有的人工文档不覆盖，只补缺的段落。`MODULE-MAP.md` 不新建：模块清单靠各模块 README 的元数据。
6. **模块文档**：初始化不给模块建文档——模块第一次要改时再按「模块文档：按需建、简要」分析着写。
7. **其他文档**：`CONTEXT.md`、`architecture.md`、`runbooks/` 等只在读项目时已经看到确定内容（例如 README 里有部署步骤）时才建。
8. **标注推断**：扫描得出的结论写成「待确认」，不把猜测写成已确认的架构事实。
9. **报告**：列出新建和修改的文件、每个文件写了什么、留下的待确认项。

初始化不改源码、不装依赖、不提交；需要提交时按 `project-vcs` 的规则由用户决定。
