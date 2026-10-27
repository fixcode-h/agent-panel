# Spec Delta · test-impact-selection

## Purpose

让增量测试选择更细、更可信：命中要给出理由，能定位到用例级就不跑整文件，必须全量要有可复核的依据，同一改动得到同一结果。

现状（已有机制，本 change 只细化不新增）：`scripts/changed-tests.mjs` 与 `scripts/lib/import-graph.mjs` 已在做 import 反向依赖闭包、高风险区强制全量（现为目录级）、`FULL_COVERAGE_RATIO = 60%`、删除 / 改名与依赖图不完整判必须全量；`scripts/unit-tests.mjs` 已支持 `--files` 只跑指定文件。下面几条需求都是在这套机制上细化（收窄到文件级契约清单、提高阈值、补命中理由、加用例级粒度），**不是**新建一套选择器。

## ADDED Requirements

### Requirement: Selection reports hit basis

选择结果 MUST 对每个命中的单测文件、界面检查分片给出理由，至少区分「直接映射」「影响面闭包」「同目录回退」三类；MUST 列出未命中测试的改动及原因。只输出文件名、不说明为什么选中 MUST 判为不合规。

#### Scenario: 每个命中都有理由

- **WHEN** 改动 `shared/task.ts` 后运行选择脚本
- **THEN** 输出里每个命中的测试文件都带「直接映射」或「影响面闭包」标记，并列出改动文件到测试的路径

#### Scenario: 未命中测试的改动单独列出

- **WHEN** 改动里包含 `docs/lessons/testing.md`
- **THEN** 输出把它归入「不涉及测试的改动」，不选任何测试，也不静默漏掉

### Requirement: Case-level selection granularity

选择 MUST 支持到测试文件内的 `describe` 组：当影响面命中只覆盖某个组时 MUST 只运行该组，当无法安全定位到组时 MUST 退到整文件并说明原因。测试文件 MUST 按单一被测单元或单一行为域拆分，使文件级选择接近用例级；单个测试文件 MUST NOT 同时覆盖多个互不相关的源模块。

#### Scenario: 只命中一个 describe 组

- **WHEN** 改动只影响某测试文件里 `describe('预算检查')` 覆盖的逻辑
- **THEN** 运行命令只执行该组用例，输出注明「用例级命中：<文件> › 预算检查」

#### Scenario: 命中跨多个组时跑整文件

- **WHEN** 影响面同时命中同一文件的三个 `describe` 组
- **THEN** 运行整个文件，输出注明「跨组命中，退到整文件」

#### Scenario: 无法定位时说明原因

- **WHEN** 测试文件没有稳定的分组命名，脚本无法判断命中范围
- **THEN** 退到整文件，输出「分组不可定位」而不是猜测一个子集

### Requirement: Justified full-run triggers

在现有触发条件（高风险区、比例阈值、依赖图不完整、删除/改名）基础上细化：只有以下情况可以判「必须全量」——高风险契约文件（CLI 定义、执行引擎、落盘 schema、内置工作流；范围从目录级收窄到文件级清单）、影响面比例达到阈值（`FULL_COVERAGE_RATIO` 从 60% 提到 75%）、依赖图存在无法解析的 import、改动包含删除或改名。每次必须全量 MUST 输出触发类别、阈值和命中的文件集合；任何其他理由 MUST NOT 触发全量。

#### Scenario: 改文档不触发全量

- **WHEN** 改动只有 `docs/**` 下的 Markdown
- **THEN** 不判必须全量，输出「不涉及测试的改动」

#### Scenario: 改高风险契约文件触发全量

- **WHEN** 改动 `shared/schema.ts`
- **THEN** 判必须全量单测，输出触发类别「高风险契约文件」、命中的文件与完整命令

#### Scenario: 依赖图不完整时说明具体文件

- **WHEN** 影响面里某个文件有解析不了的动态 import
- **THEN** 判必须全量，并输出无法解析的文件路径与那行 import

### Requirement: Reproducible selection

同一份改动清单重复运行选择 MUST 得到相同的单测文件和分片集合。缓存命中与否 MUST 只影响耗时，不影响结果；清空缓存后重跑 MUST 得到相同输出。

#### Scenario: 清缓存前后结果一致

- **WHEN** 连续运行两次选择脚本，中间清空 import 解析缓存
- **THEN** 两次输出的文件集合与分片集合完全相同

#### Scenario: 改动清单口径一致

- **WHEN** 用同一个任务基线运行两次，中间没有新的提交或工作区改动
- **THEN** 两次选择结果相同，且输出里打印同一个基线 sha

### Requirement: Empty selection is reported

改动清单为空或没有任何测试命中时 MUST 明确报告「没有对应的增量测试，交给父对话全量」，并以非零或显式标记提示；MUST NOT 静默按通过处理，也 MUST NOT 为了保险自动改跑全量而不说明。

#### Scenario: 空改动时明确提示

- **WHEN** 工作区干净且没有提供任务基线
- **THEN** 输出「改动清单为空：没有跑单测。改动已提交的话带任务基线重跑」，不显示通过结论

#### Scenario: 改动无对应测试时交给父对话

- **WHEN** 改动只涉及 `extension/` 下的浏览器扩展代码
- **THEN** 输出「这批改动没有对应的增量测试，交给父对话全量」，不静默跳过
