# 第三方与设计参考

## pi-web

核心聊天工作区的视觉和交互参考 [agegr/pi-web](https://github.com/agegr/pi-web)，研究版本 `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068`：项目/会话侧栏、紧凑工具栏、底部输入与模型选择、浅色/深色主题、折叠工具/思考、会话菜单与消息展示。

本项目使用自行实现的静态 HTML/CSS/JS 和 pi/Codex 桥接，不是该项目的完整移植。没有将未实现的文件浏览、分支、worktree、Provider/插件/技能配置呈现为可用按钮。原项目采用 MIT，Copyright (c) 2026 agegr，完整许可保存在 `third-party/pi-web-LICENSE`。

## Markdown 渲染

- marked 18.0.14：`bridge/public/vendor/marked.js`；许可 `marked-LICENSE`。
- DOMPurify 3.4.16：`bridge/public/vendor/purify.js`；许可 `dompurify-LICENSE`（Apache-2.0 / MPL-2.0 双许可）。

浏览器代码来自本项目锁定依赖的发行文件，不依赖第三方 CDN。模型内容必须经 DOMPurify 转为安全 DOM fragment；禁止活动控件、脚本、样式和远端媒体载入。代码复制按钮由可信本地代码创建。升级依赖时需同步 vendor 文件和对应许可，再跑 Markdown/XSS/桌面手机测试。
