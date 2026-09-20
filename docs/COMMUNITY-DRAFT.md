# DSH｜DSH Safekeep｜让无人值守工作中的常见文件事故尽可能可恢复

> **非官方项目，由社区成员独立开发和维护；没有 DeepSeek 官方审核或背书。**

项目地址：[SPX43JL/dsh-safekeep](https://github.com/SPX43JL/dsh-safekeep)。源码、文档、issue 和 release 均在该项目维护，本帖子仅用于发现和介绍。本文仍为草稿，尚未向 DSH 社区提交，等待维护者独立公开审查。

当我们给 Agent 高权限去长时间做事，自己又不能一直盯着电脑时，逐次确认很难成为主要保护方式。DSH Safekeep 希望保留这种自主工作体验，同时在能观察的常见文件修改前留住旧版本，让明确的移除走可恢复回收。

- 正常编辑先保存旧字节再继续，不新增逐操作确认。
- 常见永久删除会拒绝；Agent 可在已有授权内使用原生 data_safety_trash 完成可恢复移除。
- data_safety_status 展示实际加载的指纹与当前会话计数；首次安装/升级后有明确的 canary。
- 快照与回收均能 verify/restore；DSH 打不开或插件卸载后仍可用离线 CLI 恢复。

集成使用 DSH 原生 profile bundle、异步 pre-execute 和 monotonic guard，保留官方权限与文件 observation。首版验证 Windows 11 x64、本地 NTFS、Node 24.14.0、PowerShell 7.6.5、DSH 0.1.5-rc.2 的 Web/headless 原生工具模式。安装请按 GitHub README 获取精确 tgz 并核对 SHA-256；不要求全局安装。

**边界也很明确**：这不是 sandbox、完整备份或绝对防删。外部脚本内部、直接 PTC fs API、MCP/浏览器/Office 等未匹配写入、远程文件系统和同权限恶意程序均不能依赖本插件。单文件自动快照上限 64 MiB；同机库不能应对磁盘丢失，没有自动 purge。

截图：[真实 Web 演示](demo-web.png) 是真实隔离会话的脱敏总结视图；它只作使用演示，验收结论以 GitHub 内独立文件/审计核验报告为准。

欢迎提供新建合成样本的误拦、漏快照或恢复复现。请不要贴 token、账户路径、原始会话和恢复文件。

---

投稿时保持一个项目一个帖子，使用上面标题与非官方声明，补最终 GitHub 链接和截图；不维护第二套插件、不声称社区排序等于官方认证。依据 [DSH 插件专区规则](https://github.com/deepseek-ai/deepseek-harness/discussions/2004) 和[社区规则](https://github.com/deepseek-ai/deepseek-harness/discussions/1797)。本文仅为草稿，未发帖。
