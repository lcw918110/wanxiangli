# fs — 文件读取、锚点与原子编辑

层：物理能力库。入口 `wanxiangli/fs`，对象 `Filesystem({ root })`。承接主仓 CUT-24 抽出的文件观察与编辑职责：严格 UTF-8 读取、有序锚点、gitignore 感知枚举、grep、纯事务决策与原子写盘/回滚。不导入 Work、Journal、EventStore、宿主 SDK 或旧仓；直接使用运行时的 `node:fs` / `node:path`。

## AXIOM

1. [使用者] 文件字节是事实：读取返回原始 UTF-8 文本，坏编码与 NUL 字节拒绝为 `INVALID_UTF8`，绝不静默替换。
    - 理由：把二进制当文本改写，会无声破坏用户文件；修复成本远高于一次明确拒绝。
2. [使用者、开发者] 多文件修改要么全部落盘，要么全部不发生；失败回滚只还原自己写下的内容，第三方修改被保留。
    - 理由：半提交状态比失败更贵；覆盖他人写入等于偷走并发工作。
3. [开发者] 本能力脱离角色权限、JS 沙箱与宿主单独成立。
    - 理由：文件算法不需要认识 Office 权限或 LLM 会话；权限组合由外侧（主仓 CUT-25）负责。

## LEMMA

1. [AXIOM 1] 读取用 fatal `TextDecoder`；ENOENT 归类 `FILE_NOT_FOUND`，其余读失败 `FILE_READ_FAILED`。
2. [AXIOM 1; 根 LEMMA 3] 锚点按声明顺序在不可变文本上匹配；`occurrence` 1-based；未声明 occurrence 时必须唯一（`ANCHOR_NOT_UNIQUE`）；零宽匹配合法。
3. [AXIOM 3] 枚举遵守各级 `.gitignore` 与 `.git/info/exclude`、不进 `.git`、不跟随符号链接；`*` 不跨目录、`**` 跨零段或多段、`{a,b}` 展开。
4. [AXIOM 2] 纯事务决策（单意图、目标存在性、快照新鲜度、preflight）只消费注入的数据事实（existing 数组、current 映射）；commit/rollback 计划按路径规范顺序确定。
5. [AXIOM 2] 写盘前逐条校验当前内容等于预期；任一失败即按回滚计划还原已写文件（仅当磁盘仍是自己写入的内容时）。
6. [AXIOM 3] `resolveBounded` 与单目录枚举先确认输入的解析路径仍在根目录内，再以根目录和目标的 realpath 比较物理边界，拦截 `..` 逃逸与指向根外的符号链接（`PATH_DENIED`）。根目录自身或其祖先为符号链接时，合法内部路径仍可使用；`resolveToolPath` 保持主仓既有纯解析语义。
7. [根 LEMMA 4] 结果形状为 JS 原生数据 `{ ok: true, value }` / `{ ok: false, code, reason }`；code 与主仓 `JsFailure.code` 同表，不暴露 F# union。

## SPEC

1. [LEMMA 1, 6] `tests/001.test.mjs`：严格 UTF-8、NUL/坏字节拒绝、ENOENT、路径逃逸与根外符号链接拒绝。
2. [LEMMA 3] `tests/002.test.mjs`：glob 与单目录 `visibleEntries` 的 gitignore/exclude/symlink/`.git` 语义及 `{a,b}`、`**` 边界。
3. [LEMMA 2, 4] `tests/003.test.mjs`：有序锚点、occurrence、唯一性拒绝、空 pattern、非法正则、grep 行列。
4. [LEMMA 4, 5] `tests/004.test.mjs`：单意图拒绝、preflight 新鲜度、双文件中途失败回滚、第三方修改保留。
5. [LEMMA 7] `tests/005.test.mjs`：GlobMatch 内核对齐（供 CUT-26 共用）与结果形状契约。

## 边界

- 不含角色权限决策、JS 沙箱、生成式 `JsProgram` 基类与宿主工具协议（主仓 CUT-25）。
- 不持有 durable 事务事实；Prepared/Committed 事件与崩溃恢复裁决留主仓组合层。
- 主仓 `AnchorSpec` F# 声明与库侧 `{ kind, text }` JS 形状是同一契约的两种表示，由主仓桥接层转换；改码表须两仓同步。
