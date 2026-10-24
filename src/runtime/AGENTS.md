# runtime — 独立执行与物理能力

生产源码使用 F#，经 Fable 交付 JavaScript。公开入口 `wanxiangli/runtime` 导出 `Runtime`、`RuntimeTools`、`FileSession`、`Filesystem`、`ProcessSession`、`Terminal`、`OutputSpool`、`Time`。根规则和 `src/AGENTS.md` 共同适用。

## AXIOM

1. [使用者] 阻塞一个程序不能阻塞宿主、其他程序、输出排空及控制请求。
   - 理由：等待中的工作仍须可观察、可控制。
2. [使用者] 独立进程不扩大模型权限。
   - 理由：执行方式不能成为绕过授权原语的通道。
3. [开发者] 物理对象拥有真实资源、退出、输出与计量，不裁决程序或业务完成。
   - 理由：发送、信号、退出、暂停和成功具有不同后果。
4. [使用者] 已发生的效果和输出保留，未知不能伪装成成功。
   - 理由：恢复与诊断必须依赖真实事实。

## LEMMA

1. [AXIOM 1, 2] Runtime 拥有独立执行进程、隔离和通信。同步桥接只停住所属执行单元，宿主仍接收既有 SDK、输出与退出。模型只取得受控数据与原语，不取得宿主对象或跨边界可变别名。
2. [AXIOM 3; 根 LEMMA 3] RuntimeTools 拥有原语与字面锚点，保留原样字符串及 UTF-16 span，不做空白折叠；歧义事实交 program 暂停。FileSession 拥有读快照和版本校验，Filesystem 承担文件能力，不用隐式重读掩盖冲突。
3. [AXIOM 3] ProcessSession、Terminal 各自拥有进程及终端，OutputSpool 拥有输出，Time 提供物理计量与唤醒。runtime 不解释 planB，不登记程序名字，不拥有 park 表，不认识角色、评审、Work 或 deliver。
4. [AXIOM 1, 3] 物理退出只报告事实，不自行放行暂停续体。计算保护不能以跨越 call 等待的 wall-clock timeout 偷扣执行预算。
5. [AXIOM 3, 4] 请求期限与物理有界执行不同。模型 call 请求到期保留原命令；底层 ProcessSession.run 的显式 deadline_seconds、输出预算及运行硬顶继续成立，不能因删除模型面 maxDuration 而放宽。
6. [AXIOM 3, 4; 总规则 LEMMA 1] 信号和取消请求不是资源终态。清理确认 shell 和进程组退出；强杀报告真实信号，不保证 finally 或逃逸后代。现场丢失不依据名字或输出自动重跑。
7. [AXIOM 4] 文件变更保持单笔原子和读版本检查；失败不撤销此前独立效果。delta 不消费最终结果，退出码、信号、字节数与截断分别报告。输出文件在程序关闭后保留，没有自动保留期 GC。

## 永久依赖边界

program 通过公开产物使用 runtime，是明确的永久单向基础依赖。runtime 不导入 program，不复制业务账本，不接收业务 owner 全集式 Context。物理实现直接归 runtime/files、process、pty、spool、time；旧 sandbox 与八个旧入口退出，不保留转发壳。

## SPEC

1. [LEMMA 1, 4] `tests/001.test.mjs` 验证真实阻塞、SDK 结清、宿主响应、计算保护与取消；所有 Bun 宿主必须通过 PATH 的独立 bun/node 解释器启动 worker，不能复用可能指向宿主自身的 `process.execPath`，无解释器须明确拒绝。真实 `bun build --compile` 与 OpenCode 宿主分别验收。
2. [LEMMA 1] `tests/004.test.mjs` 验证对象、错误、原型及延迟 then getter 的权限边界。
3. [LEMMA 2, 7] `tests/003.test.mjs` 及迁入的 `files/tests/` 验证锚点、版本冲突、原子写、OS 路径、符号链接与硬链接。
4. [LEMMA 3, 5, 6, 7] `tests/005.test.mjs`、`process/tests/`、`pty/tests/`、`spool/tests/`、`time/tests/` 验证真实资源、输出、物理期限与收尾。窗口到期留命令和物理期限到期处置分别断言。
5. [根 SPEC 2] `scripts/tests/build.test.mjs`、`process-package.test.mjs`、`program-package.test.mjs` 验证独立构建及干净安装。实际结果统一记入宿主根 AGENTS.md。

Node 与 Bun 分别验收；本节不宣称 Windows、macOS、完整逃逸进程树监管、真实模型宿主或断电恢复已经验证。
