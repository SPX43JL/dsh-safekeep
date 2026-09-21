# v0.1.0-rc.1 — DSH Safekeep 首个公开预览版

面向 Windows 上主动给予 DSH 高权限、希望 Agent 长时间自主工作的用户。普通编辑在执行前保留旧字节，常见永久删除被拒绝后可改用可恢复移除，尽量不中断正常开发流程。

本版包含写前快照、内容校验、默认新文件/保留当前版本的原地恢复、可恢复移动、注册任务目录、当前会话状态、原生恢复工具和无需 DSH/联网的离线 CLI。无第三方 Node 运行时依赖，无安装脚本，无遥测、常驻服务或自动清理。

支持点为 Windows 11 x64 / NTFS / Node 24.14.0 / PowerShell 7.6.5 / DSH 0.1.5-rc.2，Web/headless 原生工具。验收层级、结果和已知限制见 [VALIDATION](VALIDATION.md)。核心目标是可恢复的事故减损，不是 sandbox 或绝对安全承诺。脚本内部、直接 PTC 文件系统 API、其他未匹配工具、远程写入和同权限恶意程序不在防护保证内。

首次安装按 [README](../README.md)，每个 profile 单独安装和 canary。升级前保留 profile 与 tgz；卸载后保留恢复数据，可继续使用离线 CLI。旧私人库不自动迁移。

发布附件：安装 tgz、源码 zip、SHA256SUMS、SOURCE-MANIFEST.json、PACKAGE-MANIFEST.json、BUILD-INFO.json、ARTIFACT-VALIDATION.json、ACCEPTANCE-SUMMARY.json 和 RELEASE-NOTES.md。逐文件清单、代码指纹和脱敏验收说明随附件提供；GitHub 自动生成的 Source code 归档不替代安装 tgz。

项目：[SPX43JL/dsh-safekeep](https://github.com/SPX43JL/dsh-safekeep)。MIT License，Copyright (c) 2026 SPX43JL。源码包保留 private/prepublishOnly，防止误发 npm；本版通过 GitHub Release 分发，尚未发布 npm package。项目介绍已发布于 [DeepSeek Harness 官方社区](https://github.com/deepseek-ai/deepseek-harness/discussions/7333)，仅作为展示和发现入口，不代表官方审核或背书。

发布提交的 Windows CI 结果以 [Actions](https://github.com/SPX43JL/dsh-safekeep/actions/workflows/ci.yml) 和 Release 附件中的精确 commit/run 记录为准。CI 是无模型凭据的组件验证；真实 Web/headless 模型证据与其分开记录。首次安装和升级后仍应完成当前 profile 的 status 与恢复 canary。
