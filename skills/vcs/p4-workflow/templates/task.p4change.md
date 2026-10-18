# P4 Change：<任务标识>

- 需求：<一句话>
- PROJECT_ROOT / DOC_ROOT：<绝对路径>
- Server / Client / Stream：<实际值>
- 开始时间：<ISO 8601，含时区>
- 状态：进行中 / 已验收 / 阻塞
- OpenSpec：<change 路径或不适用>

## 基线

- 任务文件：<绝对路径列表>
- 起始 `p4 opened`：<证据路径或摘要>
- 用户已有改动：<无或简述>
- default changelist：<编号或不适用>
- 已有 changelist：<任务文件对应的既有 changelist；同一用户/client 继续修改，新增修改仍归入该 changelist>

## 验收

- 验证命令与结果：<命令、退出码、结论>
- P4 专项验收：<C++ 当前工作区一次编译结果及 pending 文件清单核对，或其他资源检查；不适用则说明>
- 最终分桶：<正式 changelist 编号、类型和文件范围>
- 剩余风险：<无或简述>
- 结束时间：<ISO 8601，含时区>
