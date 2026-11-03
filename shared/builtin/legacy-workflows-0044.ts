import type { LegacyWorkflow } from './legacy.ts'

/**
 * ADR 0044（2026-11-03，工作流只由父对话启动）之前的内置工作流定义：说明里写的是「由子对话用 start_plan 启动」。
 * 只用来认出本机没改过的旧副本（升级，或「Bug 修复」下线时删掉），不再拿来新建。不要改这里的任何字符。
 */
export const BEFORE_0044: Record<string, LegacyWorkflow> = {
  'project-general': {
    document:
      '## 适用\n项目里边界清楚的功能、调整和小重构。需要完整规范链路的大功能用「功能开发（OpenSpec）」，改数据结构用「数据与配置迁移」。\n\n## 约定\n- 版本控制和文档根在第一个节点识别，后面的节点按它的结论操作。\n- 方案确认之前不写代码；确认之后中途不再逐步确认，遇到不可逆操作、需求矛盾、和方案冲突时才停下。\n- 这个工作流由子对话用 start_plan 启动，只做到「实现 + 快速检查 + 文档同步」：收尾前评审（只看这次的 diff，带交接单）、评审后的完整测试和编译、合回父对话分支（submit_merge）由执行角色在工作流跑完后按它的规则做，工作流里不放评审、完整验收和提交节点。\n- 实现节点改完只跑项目测试步骤里标「快速」的检查（类型检查、代码检查这类），记下命令和结果；完整测试和编译留到评审之后。\n- 要落盘的文档交给「文档」角色写进文档根；Bug 记录只记用户报的 Bug，开发、自测、评审中自己发现的问题不写。\n- 推送、PR、submit、合并到主干由父对话决定，子对话不执行、不询问、也不建议。\n- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'design',
            title: '识别现场与方案',
            agent: 'analyst',
            tier: 'high',
            params: {
              scene: true,
              scale: 'bounded',
            },
            confirm: true,
            instructions:
              '先识别现场（版本控制、文档根、已有改动），读 MODULE-MAP 和相关模块文档定位到模块和代码；再用一两句复述这次要做什么，给出简短方案：做法、要改的文件、验证方式、验收标准。不清楚的地方问用户，确认后再进入实现。',
          },
          {
            id: 'impl',
            title: '实现',
            agent: 'developer',
            tier: 'high',
            params: {
              lang: '多种',
            },
            retries: 1,
            instructions:
              '按已确认的方案实现，改完跑项目测试步骤里标「快速」的检查并记下命令和结果；完整测试和编译留到评审之后。改动分成几块互不依赖、不改同一个文件时，用 spawn_agents 派子任务并行做，自己负责拆分、取回结果后统一检查。',
          },
          {
            id: 'docs',
            title: '文档同步',
            agent: 'docsync',
            tier: 'low',
            instructions:
              '把这次改动同步进模块文档：职责、入口、数据流或已知问题变了才改，改到的模块还没有文档时补上；没有要更新的写明原因。这次修的是用户报的 Bug 才写 Bug 记录。',
          },
        ],
        edges: [
          ['start', 'design'],
          ['design', 'impl'],
          ['impl', 'docs'],
          ['docs', 'end'],
        ],
      },
    ],
  },
  'project-ue': {
    document:
      '## 适用\nUnreal Engine 项目的 C++ / Lua / 资源改动，Git、P4 或没有版本控制的项目都能用。\n\n## 约定\n- 目录、模块、Build.cs / Target.cs、UHT/UBT、资产和 Cook 的规则按 project-structure 和它的 UE 特化 ue-project-structure。\n- 版本控制在「识别现场与侦察」自动识别，后面的节点按识别结果操作：Git 只处理本次任务的文件；P4 修改前先 p4 edit / add，最后按 [C++]、[XLSX]、[Lua]、[Other] 分 pending。\n- 编译归父对话：子对话和工作流节点都不编译、不 Cook、不启动 Editor，只做不需要编译的检查（Lua 语法、静态检查、对照调用方自查）；评审之后由执行角色向父对话申请编译（独立分支里是 submit_merge 带 build，共用目录是 request_build），编译报错交回来再修。需要 Editor、PIE 或设备的验证登记为延期验证。\n- 这个工作流由子对话用 start_plan 启动，只做到「实现 + 快速检查 + 文档同步」：收尾前评审（只看这次的 diff，带交接单）、评审后的完整测试和编译、合回父对话分支（submit_merge）由执行角色在工作流跑完后按它的规则做，工作流里不放评审、完整验收和提交节点。\n- 实现节点改完只跑项目测试步骤里标「快速」的检查（类型检查、代码检查这类），记下命令和结果；完整测试和编译留到评审之后。\n- 要落盘的文档交给「文档」角色写进文档根；Bug 记录只记用户报的 Bug，开发、自测、评审中自己发现的问题不写。\n- 推送、PR、submit、合并到主干由父对话决定，子对话不执行、不询问、也不建议。\n- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'scout',
            title: '识别现场与侦察',
            agent: 'explorer',
            tier: 'medium',
            params: {
              scene: true,
              focus: '综合',
              stack: 'ue',
              target: '影响面',
            },
            instructions:
              '先识别现场（Git 的分支和未提交改动，P4 的 client、stream 和限定路径的 opened，或者没有版本控制）和文档根，结果里写明是哪种版本控制；再围绕这次需求侦察模块、构建和影响面，包括 C++ 与 Lua 的调用边界。',
          },
          {
            id: 'design',
            title: '确认方案',
            agent: 'analyst',
            tier: 'high',
            params: {
              scale: 'bounded',
            },
            confirm: true,
            instructions:
              '结合侦察结果给出方案：改动的模块和文件、C++ / Lua 分工、导出和反射边界、验证方式。等用户确认。',
          },
          {
            id: 'impl',
            title: '实现',
            agent: 'developer',
            tier: 'high',
            params: {
              lang: '多种',
              tdd: false,
            },
            retries: 1,
            instructions:
              '按已确认的方案实现。C++ 和 Lua 两边互不依赖时可以用 spawn_agents 派子任务并行改，导出和反射边界由你统一核对。P4 项目修改前先 p4 edit / add。不要编译（子任务也不要），有 Lua 改动时做语法检查，记下做了哪些检查；编译由执行角色在评审之后向父对话申请。',
          },
          {
            id: 'docs',
            title: '文档同步',
            agent: 'docsync',
            tier: 'low',
            instructions:
              '把这次改动同步到识别出的文档根里的模块文档；没有要更新的写明原因。这次修的是用户报的 Bug 才写 Bug 记录。',
          },
        ],
        edges: [
          ['start', 'scout'],
          ['scout', 'design'],
          ['design', 'impl'],
          ['impl', 'docs'],
          ['docs', 'end'],
        ],
      },
    ],
  },
  openspec: {
    document:
      '## 适用\n需要完整规范的复杂功能（OpenSpec）。阶段顺序由这个工作流保证，openspec 技能只负责各阶段的产物和门禁。\n\n## 关键门禁\n- 前置检查不通过就停下，先把 OpenSpec 环境准备好。\n- 设计共识和承载方式（新建规范 / 增补已有规范）一次确认。\n- 规范要过门禁：openspec validate 通过、每条需求都有 task 覆盖验证、design 没有「待定」。\n- tasks 每条验证通过才勾选，证据写进 acceptance；设计假设被证伪时停下回到设计。\n- 归档前：没有未勾选项，每个勾选都有证据；做不了的验证列成延期验证项，由用户决定立即验证还是暂缓。\n\n## 约定\n- 这个工作流由子对话用 start_plan 启动，只做到「实现 + 快速检查 + 文档同步」：收尾前评审（只看这次的 diff，带交接单）、评审后的完整测试和编译、合回父对话分支（submit_merge）由执行角色在工作流跑完后按它的规则做，工作流里不放评审、完整验收和提交节点。\n- 实现节点改完只跑项目测试步骤里标「快速」的检查（类型检查、代码检查这类），记下命令和结果；完整测试和编译留到评审之后。\n- 要落盘的文档交给「文档」角色写进文档根；Bug 记录只记用户报的 Bug，开发、自测、评审中自己发现的问题不写。\n- 推送、PR、submit、合并到主干由父对话决定，子对话不执行、不询问、也不建议。\n- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'pre',
            title: '识别现场与前置检查',
            agent: 'spec',
            tier: 'low',
            params: {
              scene: true,
              stage: '前置检查',
            },
            instructions: '先识别现场，读文档定位和这次需求相关的模块；再检查 OpenSpec 环境是否就绪。',
          },
          {
            id: 'design',
            title: '设计与压测',
            agent: 'analyst',
            tier: 'high',
            params: {
              scale: 'architectural',
              grill: true,
            },
            confirm: true,
            instructions:
              '收敛需求，写一次性的设计摘要（目标、非目标、路线、验收初稿），再用 grilling 压测。最后请用户一次确认两件事：设计共识，以及承载方式（新建规范 / 增补已有的强关联规范）。',
          },
          {
            id: 'propose',
            title: '写规范',
            agent: 'spec',
            tier: 'high',
            params: {
              stage: '落规范',
            },
            review: 'gate',
            maxRounds: 3,
            instructions: '按确认的设计和承载方式创建变更，写全 proposal、specs、design、tasks 和 acceptance 骨架。',
          },
          {
            id: 'impl',
            title: '按 tasks 实现',
            agent: 'developer',
            tier: 'high',
            params: {
              records: false,
            },
            retries: 1,
            instructions:
              '先按 specs 和 tasks 看清这次波及的模块、入口和契约；再按 tasks.md 依次实现：每条先查相关历史 Bug，改完跑这条的验证和项目的快速检查，通过才勾选并把证据写进 acceptance。互不依赖、不改同一批文件的 tasks 可以用 spawn_agents 派子任务并行做，勾选和证据由你统一核对后再写。做不了的验证登记为延期验证。发现设计假设不成立时停下，写明哪条假设、证据和受影响的 tasks。',
          },
          {
            id: 'deferred',
            title: '延期验证项',
            agent: 'tester',
            tier: 'medium',
            params: {
              scope: '本次改动',
              regress: false,
            },
            confirm: true,
            instructions:
              '不重跑整套测试（评审后由执行角色统一跑）：把实现中登记的延期验证项列出来，每项写怎么验证、需要什么环境，请用户决定立即验证还是暂缓（暂缓的标为「待用户完成」）。',
          },
          {
            id: 'archive',
            title: '归档',
            agent: 'spec',
            tier: 'medium',
            params: {
              stage: '归档',
            },
            instructions: '检查归档门禁后归档这次变更。',
          },
          {
            id: 'docs',
            title: '文档同步',
            agent: 'docsync',
            tier: 'low',
            instructions:
              '把这次变更涉及的模块文档同步好（归档后的主 specs 不用再抄一遍）；没有要更新的写明原因。这次修的是用户报的 Bug 才写 Bug 记录。',
          },
        ],
        edges: [
          ['start', 'pre'],
          ['pre', 'design', 'pass'],
          ['design', 'propose'],
          ['propose', 'impl'],
          ['impl', 'deferred'],
          ['deferred', 'archive'],
          ['archive', 'docs'],
          ['docs', 'end'],
        ],
      },
      {
        id: 'gate',
        name: '规范门禁',
        description: '检查规范是否能进入实现',
        nodes: [
          {
            id: 'gate',
            title: '规范门禁',
            agent: 'spec',
            tier: 'medium',
            params: {
              stage: '规范门禁',
            },
            instructions: '检查上面「输入」里的规范。',
          },
        ],
        edges: [
          ['start', 'gate'],
          ['gate', 'end'],
        ],
      },
    ],
  },
  migration: {
    document:
      '## 适用\n表结构、本地数据文件、配置格式、存档格式这类「旧数据还在用」的改动。普通功能开发用「通用项目」，不要为了改字段走这个流程。\n\n## 约定\n- 先定兼容策略再写代码：一次性迁移 / 双读写 / 懒迁移，三选一并写理由；不可逆的步骤要单独标出来。\n- 迁移和回滚必须成对写，并且都能重跑（幂等）；没有回滚方案的迁移不算完成。\n- 用真实的旧数据样本验证，不能只验证新格式；样本从哪来、怎么脱敏要写清楚。\n- 切默认值（删旧字段、删旧读取路径）放到最后一步，确认线上 / 用户数据都迁完再做。\n- 这个工作流由子对话用 start_plan 启动，只做到「实现 + 快速检查 + 文档同步」：收尾前评审（只看这次的 diff，带交接单）、评审后的完整测试和编译、合回父对话分支（submit_merge）由执行角色在工作流跑完后按它的规则做，工作流里不放评审、完整验收和提交节点。\n- 实现节点改完只跑项目测试步骤里标「快速」的检查（类型检查、代码检查这类），记下命令和结果；完整测试和编译留到评审之后。\n- 要落盘的文档交给「文档」角色写进文档根；Bug 记录只记用户报的 Bug，开发、自测、评审中自己发现的问题不写。\n- 推送、PR、submit、合并到主干由父对话决定，子对话不执行、不询问、也不建议。\n- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'plan',
            title: '范围与兼容策略',
            agent: 'analyst',
            tier: 'high',
            params: {
              scene: true,
              scale: 'architectural',
            },
            confirm: true,
            instructions:
              '识别现场后确认：要迁哪些数据结构、所有读写这些数据的路径（含外部调用方和已有数据文件）、能不能停服、选哪种兼容策略（一次性 / 双写 / 懒迁移）。给出迁移和回滚的步骤，等用户确认。',
          },
          {
            id: 'impl',
            title: '实现迁移与回滚',
            agent: 'developer',
            tier: 'high',
            params: {
              tdd: true,
            },
            retries: 1,
            instructions:
              '先写迁移失败的测试（用旧数据样本），再写迁移、回滚和兼容读取。迁移脚本必须幂等、能重跑；每一步在大数据量下的耗时和失败处理写清楚。改完跑快速检查。',
          },
          {
            id: 'verify',
            title: '旧数据验证',
            agent: 'tester',
            tier: 'medium',
            params: {
              scope: '本次改动',
              env: '自动',
              regress: false,
              onFail: '只报告',
              write: true,
            },
            confirm: true,
            instructions:
              '只验证迁移本身（整套测试评审后由执行角色跑）：在旧数据样本上跑迁移 → 校验 → 回滚 → 再迁移，确认数据没有丢失或重复。跑完把结果和剩下的风险列清楚，请用户决定是否可以切默认值。',
          },
          {
            id: 'docs',
            title: '文档同步',
            agent: 'docsync',
            tier: 'low',
            instructions: '把迁移方案、兼容策略和回滚步骤写进相关模块文档；定下了以后不好改的格式或策略时写 ADR。',
          },
        ],
        edges: [
          ['start', 'plan'],
          ['plan', 'impl'],
          ['impl', 'verify'],
          ['verify', 'docs'],
          ['docs', 'end'],
        ],
      },
    ],
  },
  deps: {
    document:
      '## 适用\n依赖过期、收到安全告警、要升大版本，或者定期做一次依赖体检。\n\n## 约定\n- 先体检再动手：体检节点只出清单和风险，不改 lock 文件。\n- 升级按可回滚的批次：一次一组相关依赖，装完跑项目测试步骤，通过再进下一批；一批不过就回退这一批，写明原因。\n- 漏洞按可利用性排序，不夸大：没有被利用路径的要说明为什么。\n- 不擅自改包管理器、不混用锁文件；不动用户已有的未提交改动。\n- 这个工作流由子对话用 start_plan 启动，只做到「实现 + 快速检查 + 文档同步」：收尾前评审（只看这次的 diff，带交接单）、评审后的完整测试和编译、合回父对话分支（submit_merge）由执行角色在工作流跑完后按它的规则做，工作流里不放评审、完整验收和提交节点。\n- 实现节点改完只跑项目测试步骤里标「快速」的检查（类型检查、代码检查这类），记下命令和结果；完整测试和编译留到评审之后。\n- 要落盘的文档交给「文档」角色写进文档根；Bug 记录只记用户报的 Bug，开发、自测、评审中自己发现的问题不写。\n- 推送、PR、submit、合并到主干由父对话决定，子对话不执行、不询问、也不建议。\n- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'audit',
            title: '依赖体检',
            agent: 'deps',
            tier: 'medium',
            params: {
              mode: '只体检',
              audit: true,
              license: true,
            },
            confirm: true,
            instructions:
              '查这个项目的依赖现状：过期清单、安全漏洞（按严重程度）、许可证冲突、大版本升级的破坏性变更。每条都带命令输出或文件路径。最后给出建议的升级批次和每批的风险，请用户确认升级范围。',
          },
          {
            id: 'upgrade',
            title: '分批升级',
            agent: 'deps',
            tier: 'high',
            params: {
              mode: '升级补丁版',
              audit: true,
            },
            retries: 1,
            instructions:
              '按用户确认的批次升级。每批升级后装依赖、跑项目测试步骤，通过才进下一批；失败就按 systematic-debugging 找根因，修不好就回退这一批并说明。',
          },
          {
            id: 'docs',
            title: '文档同步',
            agent: 'docsync',
            tier: 'low',
            instructions: '有依赖策略或升级记录相关的文档时同步它们（有长期决策时写 ADR）；没有要更新的写明原因。',
          },
        ],
        edges: [
          ['start', 'audit'],
          ['audit', 'upgrade'],
          ['upgrade', 'docs'],
          ['docs', 'end'],
        ],
      },
    ],
  },
  bugfix: {
    document:
      '## 适用\nBug、测试失败、线上问题。执行角色默认在对话里直接按「按模块逐层定位」找和修，只有设成「总是按工作流」时才用这个工作流。\n\n## 约定\n- 从用户点名的模块（或父对话交来的模块）开始查；这一层排除了才往下一层，找到能完整解释现象的原因就修，修完就停，不再往底层挖。\n- 拿不准时先加日志或写测试复现，不改代码去猜；没找到根因不修。\n- 修复前先有能复现问题的测试或步骤，修复后它必须通过。\n- 下到第三层还没找到、或者连续三次修复失败，就停下来报告查过的层和排除依据。\n- 修完写 Bug 记录：症状、复现、根因、修复、回归测试、防复发。只记用户报的 Bug；修的过程中自己发现、顺手修掉的其他问题不写 Bug 记录。\n- 这个工作流由子对话用 start_plan 启动，只做到「实现 + 快速检查 + 文档同步」：收尾前评审（只看这次的 diff，带交接单）、评审后的完整测试和编译、合回父对话分支（submit_merge）由执行角色在工作流跑完后按它的规则做，工作流里不放评审、完整验收和提交节点。\n- 实现节点改完只跑项目测试步骤里标「快速」的检查（类型检查、代码检查这类），记下命令和结果；完整测试和编译留到评审之后。\n- 要落盘的文档交给「文档」角色写进文档根；Bug 记录只记用户报的 Bug，开发、自测、评审中自己发现的问题不写。\n- 推送、PR、submit、合并到主干由父对话决定，子对话不执行、不询问、也不建议。\n- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。',
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'fix',
            title: '定位并修复',
            agent: 'developer',
            tier: 'high',
            params: {
              scene: true,
              task: '修 Bug',
            },
            retries: 1,
            instructions:
              '先识别现场，确定从哪个模块查起（输入里点名的模块或部分优先），查 bugs.md 里有没有相似的历史 Bug；再按「按模块逐层定位」找到根因并修复这个问题，跑复现用例和快速检查。',
          },
          {
            id: 'docs',
            title: 'Bug 记录',
            agent: 'docsync',
            tier: 'low',
            instructions:
              '为用户报的这个 Bug 写 Bug 记录（模块 bugs.md 加索引，bugs/<id>.md 写症状、复现、根因、修复、回归测试、防复发）并同步相关模块文档；修的过程中自己发现的其他问题不写 Bug 记录。',
          },
        ],
        edges: [
          ['start', 'fix'],
          ['fix', 'docs'],
          ['docs', 'end'],
        ],
      },
    ],
  },
}
