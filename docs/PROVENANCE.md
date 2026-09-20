# 来源、依赖和许可证

## 自有源码来源

恢复、路径、回收事务、临时目录与命令分析来自此前私有的多平台本地实现，经本轮公开审查修改；DSH adapter 来自已经分别完成 Web/headless 本地验收的实现。本次只选取 DSH 所需组件，未带入其他宿主 hook、安装配置、启动日志或私人样本。

- `lib/recovery.mjs`、`safe-trash.mjs`、`safe-temp.mjs`、`transactions.mjs`、`paths.mjs`：既有恢复逻辑；新增独立根、按用户划分的跨盘私有库、链接检查。
- `guard-core.mjs`、`powershell.mjs`、`powershell-analysis.ps1`：既有命令/路径分析；修正裸盘符、UNC 和模块限定 Out-File；PowerShell 只解析，不求值。
- `dsh-plugin.mjs`、`dsh-safety.mjs`：既有公开 API 集成；本轮增加会话状态、原生恢复工具、权限门及预检查参数固定。
- `storage.mjs`、`storage-acl.ps1`、`operations.mjs`、公开 CLI、打包/公开检查脚本及公开文档：本轮新增。
- 测试：保留核心恢复、宿主组件、PTC 组件的实际断言，移除固定用户安装路径；新增公开接口、加载与权限回归。

早期私有实现没有 Git 历史，无法据此证明完整逐行原创链。历史定向相似扫描未发现连续精确匹配，并非版权法律结论。公开准备没有从外部项目复制实现文件。维护者已决定以 MIT 许可证公开此分发，版权署名为 SPX43JL；没有用自动扫描代替来源判断。

参考项目（思路比较，不代表复制、依赖或协作）：[dsh-safety](https://github.com/sugarxl/dsh-safety)、[dsh-safe-delete](https://github.com/Qintsg/dsh-safe-delete)、[dsh-file-undo](https://github.com/QinLuza/dsh-file-undo)、[dsh-safety-net](https://github.com/Asuna486-desuwa/dsh-safety-net)、[dsh-security-guard](https://github.com/bigclawd/dsh-security-guard)、[dsh-riskproof](https://github.com/onlyqzq/dsh-riskproof)。

## 第三方边界

公开 tgz 只有本项目代码、文档和 MIT/NOTICE。运行时依赖 Node 24 与 PowerShell 7，本插件本身没有 npm dependencies/peerDependencies，不把另一份 DSH/Cordis 装入 profile，避免服务身份和版本重复。

开发依赖为固定 `@deepseek-ai/dsh@0.1.5-rc.2`，完整解析锁在 package-lock.json；其依赖树不打入发布包。DSH 声明 MIT，其他测试依赖遵循各自许可证。不要把完整 node_modules 拿来当源码或发布压缩包；将来 vendoring 第三方代码时必须单独记录来源 commit、版权、原许可证、修改和适用 NOTICE。

## 项目与许可证

项目为 **DSH Safekeep**，仓库/package 名称为 **dsh-safekeep**，由 [SPX43JL](https://github.com/SPX43JL) 独立维护。源码、文档、问题和 Release 的唯一项目入口为 [SPX43JL/dsh-safekeep](https://github.com/SPX43JL/dsh-safekeep)。没有 DeepSeek 官方审核或背书。

许可证为 [MIT](../LICENSE)，Copyright (c) 2026 SPX43JL。完整许可条件以 LICENSE 原文为准；产品支持范围和限制另见 [SAFETY](SAFETY.md)。

首版通过 GitHub Release 分发 tgz，尚未发布或保留 npm 名称。请使用本项目链接和精确版本，不能把未来可能出现的同名 registry 条目自动视为本项目。
