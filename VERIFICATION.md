# v1.1.0 验证记录

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
