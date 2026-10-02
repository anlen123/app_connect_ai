# 验证与需求审计

验证日期：2026-10-02。所有下列通过结果均来自执行结果，而非仅检查源代码。Release APK 是本次测试构建的同一份文件。公开记录已脱敏测试电脑的地址及本机项目路径；配对参数也已脱敏。

## 逐项对照

| 需求 | 实现与证据 | 结果 |
|---|---|---|
| 安卓 APP | 原生 Java APK，Android 8.0+，compile/target SDK 35；Android 15 x86_64 模拟器运行 | 通过 |
| 经局域网连接 Windows WSL | Windows 局域网 IP 的 8787 端口 NAT portproxy 到 WSL；Windows/WSL HTTP health；Android `RealAgentTest` 使用该 Windows LAN IP，而非 localhost | 通过 |
| pi | 真正的持久 RPC 子进程；真实模型列表、对话、工具调用、模型切换、`/lan-check` 选择回传 | 通过 |
| Codex | 真正的 app-server stdio 子进程；initialize/thread/turn/model API；真实模型列表、对话、工具调用、模型切换 | 通过 |
| APP 对话输入与输出 | UIAutomator 实际填写输入框并发送，流式呈现；真实 Android → pi/Codex 都收到 `LAN_ANDROID_OK` | 通过 |
| 思考信息 | pi thinking delta/final、Codex reasoning delta/summary 映射单测；APP 显示确定性测试 agent 的流式 thinking 事件，截图 `lan-chat.png`；最终权威内容覆盖 delta，未显示签名 | 通过（公开内容边界见下） |
| QR 或 IP | APP 手动 IP/配对码连接；电脑生成实际 QR 位图，Android ZXing 解码、Pairing.parse、加密保存回读；相机扫码 Activity 实际启动和返回 | 通过 |
| APP 切换模型 | UI 从 Model A 切换至 B；真实 pi 和 Codex 均切到另一个真实可用模型再恢复，返回模型标识核验 | 通过 |
| 电脑任务进度 | Playwright 电脑面板创建 Codex 会话/任务、实时计划/工具/等待状态/完成；APP 与电脑共享桥接会话，WSL 终端显示任务事件 | 通过 |
| 完成系统通知 | Android 后台时 NotificationManager 与真实系统通知栏核验、点击跳回对应会话；真实 pi/Codex 完成都产生完成通知 | 通过 |
| 要选择时系统通知 | UIAutomator 检查系统“需要你的选择”，点击通知显示选择卡片，真实点击并回传；真实 pi 的 RPC dialog 经 Windows IP 到 Android 也验证通知和回传 | 通过 |
| 断线与历史 | Android 主动中断实际 WebSocket，在离线间隙完成任务，重连回放后系统完成通知；桥接重启恢复历史、明确 offline | 通过 |

模型提供方并不保证返回全部内部思考。本次真实 gpt-6.1-sol 冒烟返回了文本/工具，但未返回公开思考（`real-agent-smoke.json` 的 thinking=0）。APP 转发所有公开思考/摘要；协议流、权威最终内容与 APP 思考呈现已分别测试，不伪造提供方隐藏的内容。pi 支持时默认 medium thinking，Codex 请求公开推理摘要。

实体手机、不同厂商强制省电和实际相机对准屏幕的光学扫码条件未声称已实测。已测试实际 Android 系统上的网络、界面、相机启动、二维码位图解码、后台服务、权限和通知。IP 连接已端到端覆盖，手机可直接使用该已验证链路。

## 执行结果

- `npm test`：**7/7 通过**。鉴权/跨域拒绝、模型、对话、thinking、选择、完成、回放、路径越界拒绝、UTF-8 JSONL 分帧、pi settled/retry、Codex 审批/问题/计划。
- `node test/real-smoke.js`：**pi 与 Codex 均通过**，真实只读工具调用，完成状态和 `LAN_SMOKE_OK`；模型数分别 455 和 8。
- `node test/real-interaction.js`：**通过**，真实 pi RPC `/lan-check` 对话、prompt 仍等待时提交答案、收到选择结果并完成。
- `npx playwright test`：**2/2 通过**，电脑面板全流程及 launcher fragment 登录、HTTP URL 不泄漏配对码。
- `:app:assembleDebug :app:lintDebug`：**BUILD SUCCESSFUL**，lint 无错误。保留的非阻塞警告包括更新版本建议和部分 UI 文案国际化建议。
- Android `EndToEndTest`：**2/2 通过**，输入/模型/公开思考、前后台通知、选择跳转回传、断线通知回放、QR 解码、相机打开。
- Android `RealAgentTest`：**1/1 通过，0 skipped**，真实 Windows LAN → WSL → pi/Codex 对话/工具/模型切换/后台通知；真实 pi 待选择交互也覆盖。
- `apksigner verify`：**通过**，Android Debug 签名；没有宣称为应用商店 release 签名。
- Windows PowerShell 对部署/launcher 脚本 AST 检查：**0 syntax errors**；NAT 部署脚本已实际执行。
- Windows 防火墙核验：LocalAddress 为指定局域网 IP，`RemoteAddress=LocalSubnet`。
- Windows 经局域网地址 `/app.apk` 下载的 APK 与构建产物 SHA-256 **一致**。
- 最终依赖审计：见 `artifacts/npm-audit.json`。
- LSP 检查：7 个文件中 4 个确认无错误，3 个 push-only 检查无法单独确认；没有用静默结果冒充全部干净。Java 编译/lint、实际 Pi TS extension 加载、JS 运行测试提供补充验证。

## APK

- 文件：[Release 附件 lan-agent-1.0.0.apk](https://github.com/anlen123/app_connect_ai/releases/download/v1.0.0/lan-agent-1.0.0.apk)（二进制不存入 Git 历史）
- 包名：`dev.lanagent`
- 版本：`1.0.0` / versionCode 1
- 大小：4,720,608 字节
- SHA-256：`45a60de384c22f2a94ce8d3204e295b66d25d8df00fe37da673e319aa32b57d9`
- Release 安装包与本机已验证的安装包 SHA-256 相同。

## 证据文件

`artifacts/`：

- `bridge-tests.txt`、`real-agent-smoke.json`、`real-pi-interaction.json`、`real-smoke.txt`、`real-interaction.txt`。
- `desktop-tests.txt`、`desktop-running.png`、`desktop-completed.png`。
- `android-fixture-junit.xml`（2 个测试）、`android-live-junit.xml`（1 个真实测试）、构建日志、`android-lint.xml`。
- `lan-chat.png`、`lan-choice-notification.png`、`lan-completed-notification.png`、`lan-scanner.png`。
- `SHA256SUMS` 与依赖审计。APK 另见 Release 附件；私有部署配置不上传。
- `android-fixture-build.txt`、`android-live-build.txt` 为脱敏的成功构建/测试日志。

真实配对码、AI 凭据、私有 token 文件和完整生产会话日志均不属于交付包。真实测试的配对参数已从复制的报告中脱敏。测试 fixture 中的固定 token 仅用于独立测试端口，不是生产配对码。
