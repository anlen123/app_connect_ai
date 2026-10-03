# v1.2.1 — 任务进度、公开思考与原生会话重启

验证日期：2026-10-03。生产 `lan-agent-web` 仍为 inactive/dead，未启动 :8787、未修改正式配对码。

- **20/20 单元测试**：启动期进度过滤、空白思考过滤、原生引用持久化、模型/历史保留、旧进程晚到事件隔离、并发重启与重启中删除、旧记录唯一匹配与安全拒绝、Codex thread/resume 与公开摘要请求。
- **14/14 非 localhost HTTP 桌面/手机测试**：新会话空白、思考两段逐步可见、手动折叠、关闭后按钮重启、保留模型/ID/历史，以及全部原工作区测试。
- **4/4 真实原生重启场景**：桌面/手机视口 × Pi/Codex；真实子进程关闭退出，再启动不同 PID；第二问没有提供第一问随机口令，也无工具/读文件，仍正确复述。桌面两场景还关闭、重建整个 bridge 后恢复原生上下文。
- **5/5 原真实发布门禁回归通过**：真实工具读取、换模型推理、跨设备 Pi 选择、历史与删除、运行中 Codex 删除。本轮首次回归有三次 140 秒超时；单独工具探测成功后完整重跑通过，没有增大超时或绕过断言。没有将首次失败称为通过。
- 思考边界：最终四场真实重启测试均收到实际思考开始事件，并在任务完成前显示“思考中”；提供方这些请求没有公开文字（报告计数为 0），**不把它称为真实思考文字流验证**。文字流逐段显示有确定性浏览器测试覆盖；先前真实尝试也观察到公开 delta，但不是本次完整通过报告的证据。
- LSP 八个修改文件零错误诊断，五个确认 clean、三个 inconclusive；运行测试提供进一步证据。
- 本次为 Web/bridge 修复，Android 源码/APK 未变；沿用已发布 v1.2.0 APK，没有声称重跑实体手机或 Android 安装测试。

证据：`artifacts/restart-{unit-tests,browser-tests,real-tests,regression-tests}.txt`、`restart-real-report.json`、`restart-regression-report.json`。隔离临时目录和临时配对码，不含正式历史或凭据。

---

## 历史 v1.2.0 — pi-web 核心交互与自定义配对码

验证日期：2026-10-03。用户选择核心聊天工作区、管理员设置共享配对码；没有扩展到文件/Git/worktree/插件等未实现功能。实际服务按用户要求继续停止，本次没有启动正式 :8787，也没有改用户原配对码。

## 本次通过结果

- **16/16 单测**：新增12–256字符共享码、私有0600原子存储、正确/错误码、显式重启轮换、跨新Socket尝试限流、可选无凭据网页二维码。
- **12/12 桌面/手机浏览器测试**：非localhost HTTP，使用小于旧24字符限制的管理员自定义码；两agent聊天/模型/菜单重命名/删除/刷新/跨端选择；深浅主题持久化、安全Markdown标题/表格/代码、XSS主动内容移除、折叠思考/工具、代码复制/导出、项目筛选、桌面快捷键配置与手机Enter换行。
- **5个真正 pi/Codex 场景**（含父测试TAP6/6）：新界面桌面×手机×两agent、切到另一真实模型再推理、上下文保留、真实pi跨端选择、菜单重命名/历史/删除及运行中Codex删除。报告 `pi-web-real-web-report.json` pass=true，5/5。
- **实际 Android15 模拟器 Chrome124，两agent通过**：真实触摸、普通HTTP、新界面/菜单、真实模型工具/回复、删除及进程/日志移除。不是仅桌面移动仿真。报告 `pi-web-actual-android-browser.json`。
- **新版APK编译/lint及Android 3/3测试通过**：原通知/二维码/删除/相机测试继续通过，新增13字符自定义码的解析/加密存储及非法码拒绝。APK debug签名，versionCode3；SHA256 `29221bc4b2be8f6cd329f0e9067337624701c5c1548b7721a9bf1612f916d81d`。
- **CLI配置/启动测试通过**：码不出现在设置输出或启动日志；首次启动缺管理员码时明确拒绝。测试全部使用临时码与私有临时目录，未修改正式凭据。
- 所有依赖审计 **0漏洞**；LSP5文件没有错误诊断，但只有2确认clean、3inconclusive；没有把静默结果称为全clean。

证据为 `artifacts/pi-web-*.txt/json/xml/png`。许可证/参考版本见 `THIRD_PARTY.md`，Markdown使用本地marked+DOMPurify安全DOM fragment，远端媒体和活动元素禁用。未声称实体手机验证或HTTP网页关闭后的通知支持。正式systemd服务仍inactive/dead；这是有意保持停机，不是可用性结论。

---

## 历史：v1.1.0 验证记录（不代替上述 v1.2.0 验证）

验证日期：**2026-10-03**。本次要求是普通 Linux 网页，电脑和手机访问同一服务完成 agent/新会话/模型/删除操作。没有以 `/health`、localhost 浏览器或假 agent 成功替代真实端到端验证。

## v1.0.0 故障与修复

非 localhost 的普通 HTTP 来源中 `isSecureContext=false`，`crypto.randomUUID` 未定义。旧版创建命令时调用它，导致登录后仍无法正常使用。旧浏览器测试只在 localhost 跑，漏掉该条件。

v1.1.0 改用不依赖安全来源的请求 ID；重写响应式会话操作，修复删除后空态 DOM 引用；新增真正删除 API、并发删除保护、进程退出等待、手机直接进入网页的二维码及错误反馈。启动流程独立于 Windows/WSL。

## 本次执行结果

| 验证 | 实际结果 | 范围与限制 |
|---|---|---|
| `npm test` | **13/13** | 鉴权/Origin、模型/消息/思考映射、重命名/关闭/删除/重启、删除中的初始化/运行/晚到回调、路径和二维码；使用确定性 agent 单元测试 |
| `npx playwright test` | **8/8** | 桌面和 Pixel5 手机视口；真实 Linux 网卡 HTTP 地址；两 agent 创建/聊天/模型/重命名/刷新/删除/空态、跨端同步、扫码链接、错误反馈；此组使用 fixture agent |
| `node --test test/real-web.live.js` | **5 个真实场景全通过**（TAP 含父测试 6/6） | **真实 pi/Codex CLI，无 mock**；桌面×手机视口×两 agent；真实工具读随机上下文、切换另一模型后实际推理且保留上下文；第二问不泄漏待复述的随机上下文，且无新增读文件工具；真实 pi 选择在另一端回答；重命名/刷新/跨端删除；额外真实运行中 Codex sleep 任务删除 |
| `node test/android-browser.live.js` | **真实 Android Chrome 的 pi/Codex 两场景均通过** | Android15 x86_64 模拟器上的实际 Chrome124（不是仅桌面移动仿真）；真实触摸、LAN HTTP、网页扫码链接登录、选 agent/新建、切到 gpt-6-sol 后真实工具/回复、删除与进程退出/日志移除；无水平溢出 |
| `node test/deployment.live.js` | **运行中的 Linux :8787 服务两场景通过** | 升级后的实际服务（不是临时 fixture）：桌面 pi / 手机视口 Codex，真实模型切换/工具/回复、reload历史、删除；升级前已有会话全部保留，测试只删除自身新建会话 |
| Android `assembleDebug` / `lintDebug` / `EndToEndTest` | **BUILD SUCCESSFUL；2/2，0 skipped** | 新版 APK 的实际 Java/UIAutomator 网络/模型/聊天/公开思考、完成/选择通知与跳转、重连回放、相机启动、QR 位图解码、JSON/网页二维码解析、删除通知清理与空态；agent 为独立 fixture |
| `apksigner verify` | **通过** | 同一份新版 debug APK；不是商店 release 签名 |
| `npm audit --omit=dev` | **0 漏洞** | 生产依赖，见版本化 JSON 记录 |

以上 HTTP 浏览器测试都确认安全来源为 false、`crypto.randomUUID` 为 undefined。没有强制将 HTTP 视为安全来源、没有 monkeypatch 该 API，也没有模拟真实 agent 的成功回复。

## 自动化同步问题的处理

真实浏览器门禁早期发现测试错误等待了上一轮“已完成”，以及读取了异步配对弹窗尚未填入的 URL。已改成先等待该轮独有回复、再等待完成，以及等二维码对话框可见后读取，最后完整真实门禁退出码为 0。

实际 Android Chrome 冷启动时，系统在 boot-complete 后更新全局资源覆盖层并重建 Activity/标签，导致调试连接失效。等待系统初始化稳定后，使用 Playwright Android 接口和触摸输入，两实际场景通过。这不是通过强制安全来源绕过网页错误。

## 诚实边界

- 真实浏览器/真实 CLI 验证与确定性 fixture 验证已分开标注。
- 实测 Android 是模拟器，**没有声称已测试实体手机、所有浏览器、厂商强制省电策略或相机对准实体屏幕的光学条件**。
- 普通 HTTP 浏览器不保证锁屏或关闭网页后的系统通知。原生 APP 的后台通知单独测试。
- 思考只展示提供方公开返回的内容；真实模型可能不返回摘要。流式/最终思考映射和展示由 fixture 覆盖，不把假数据当作真实内部思考。
- LSP 6 文件未报错，但只有 2 个确认 clean，4 个 inconclusive；未用空结果冒充全面无错。JS 测试、真实 CLI 加载、Java 编译/lint 和浏览器执行提供运行证据。
- 旧 `artifacts/` 中无 `v1.1-` 前缀的报告是 v1.0.0 历史记录，不能代替本次验证。

## 新版证据

`artifacts/`：

- `v1.1-unit-tests.txt`、`v1.1-browser-tests.txt`、`v1.1-real-web-tests.txt`。
- `v1.1-real-web-report.json`：expectedScenarios=5、passedScenarios=5、pass=true。
- `v1.1-actual-android-browser.json`、`v1.1-actual-android-browser.txt`、两张 actual-android-chrome 截图。
- `v1.1-live-deployment.json`、`v1.1-live-deployment.txt`。
- 四张 desktop/phone-linux-http 截图和四张 real-desktop/phone 截图。
- `v1.1-android-fixture-junit.xml`、`v1.1-android-build.txt`、`v1.1-npm-audit.json`。

### APK

- Release 附件：`lan-agent-1.1.0.apk`，包名 `dev.lanagent`，versionCode 2。
- 大小：**3,161,719 字节**。
- SHA-256：`d2722049b98e241c1b813cde345c158302b487fe738d5c88530c1da6fbd21d15`。
- debug 签名测试客户端，手机网页不依赖它。

公开证据不包含生产配对码、AI 凭据、私有会话内容或完整生产日志。固定 fixture token 仅属于独立测试服务。源码 ZIP 由发布提交的 Git archive 生成，不包含工作目录缓存、私有恢复笔记或 APK。
