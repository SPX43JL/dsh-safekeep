# DSH Safekeep

**非官方 Windows 插件。让高权限、无人值守的 DeepSeek Harness 工作流中，常见文件事故尽可能可恢复。**

普通编辑先保存旧字节，随后继续执行，不增加逐操作确认。识别到永久删除等危险操作时拒绝，并提供可恢复移除工具，让 Agent 在既有授权内继续工作。适合已经主动授予 DSH 高权限、不能一直盯着电脑的人。

**它不是 sandbox、完整备份或绝对防删保证。** 脚本内部、未匹配工具和直接 PTC 文件系统 API 的写入可能完全不被观察。快照上限为单个旧文件 64 MiB；同机恢复库不能应对磁盘丢失。请先读[覆盖范围](docs/SAFETY.md)。

当前版本为 **0.1.0-rc.1 公开预览版**，采用 MIT 许可证，维护者为 SPX43JL。请从 [GitHub Release](https://github.com/SPX43JL/dsh-safekeep/releases/tag/v0.1.0-rc.1) 下载精确版本；本项目尚未发布 npm package，不要用 `@latest` 猜测安装。

## 已验证环境

Windows 11 x64、本地 NTFS、Node.js 24.14.0、PowerShell 7.6.5、DSH **0.1.5-rc.2**，Web / headless，原生 `read` / `write` / `edit` / `pwsh` 工具模式。原生恢复工具的写操作要求当前 DSH `danger-full-access`；插件不会切换权限模式。PTC 嵌套原生工具有组件证据，未承诺 PTC 程序内部的任意写入。

首版只声明这一明确支持范围。其他 Windows/Node/PowerShell/DSH 版本、第三方 shell 和任意插件组合须重新验收；不声明 macOS/Linux、DSH Desktop/ACP/Teams 支持。详见[兼容与维护](docs/MAINTENANCE.md)、[验收报告](docs/VALIDATION.md)。

## 安装

准备 Node 24、PowerShell 7、pnpm 和已能正常使用的 DSH 0.1.5-rc.2。运行 `node --version`、`pwsh --version`、`pnpm --version`、`dsh --version` 核对。插件不会安装或升级 DSH、切换模型或配置凭据。

1. 从 [v0.1.0-rc.1 Release](https://github.com/SPX43JL/dsh-safekeep/releases/tag/v0.1.0-rc.1) 取得 `dsh-safekeep-0.1.0-rc.1.tgz`、`SHA256SUMS` 和 `BUILD-INFO.json`，用 `Get-FileHash -Algorithm SHA256` 比较完整散列。保留 tgz，它也提供离线恢复 CLI。GitHub 自动生成的 Source code 压缩包不是 DSH 安装包。
2. 退出准备修改的 DSH profile。先保留该 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.yaml`（存在的文件）和上一版 tgz 到新的私有备份目录。不要向 issue 上传这些文件。
3. 将 tgz 放在不含空格和 shell 元字符的路径，例如 `C:\DSHPackages`。这是当前 DSH Windows plugin→pnpm 转发的路径约束；工作文件路径仍可含空格和中文。
4. 按实际使用入口安装。Web 和 headless 是两个独立 profile，安装其中一个不会保护另一个。

```powershell
dsh plugin --profile web add C:\DSHPackages\dsh-safekeep-0.1.0-rc.1.tgz --save-exact --ignore-scripts --config.auto-install-peers=false
dsh plugin --profile headless add C:\DSHPackages\dsh-safekeep-0.1.0-rc.1.tgz --save-exact --ignore-scripts --config.auto-install-peers=false
```

重启相应 profile。无需全局安装本插件；无 postinstall、联网遥测或后台服务。Web 使用 DSH 启动时输出的认证地址；保持回环监听，不要公开 token。源代码开发安装见[维护文档](docs/MAINTENANCE.md)。

## 确认当前会话真正生效

在 DSH 中要求调用 `data_safety_status`。确认 `loaded: true`、`storage.ok: true`、版本与 Release 附件 `BUILD-INFO.json` 的 `codeHash` 一致，并检查 `currentSessionId`。工具不存在、存储失败或指纹不同，都不能认为已经保护。

随后运行[首次安装 canary](docs/RECOVERY.md#首次安装-canary)：在新建的注册目录内读→编辑样本，核对 `currentSession.snapshots` 增加，找到快照、校验并恢复旧字节；对**从未创建**的文件只尝试一次删除负例，确认拒绝且计数增加。配置里出现包名或一次绿色 status 均不能代替这个验证。每次升级、修改 profile 或 DSH 更新后重做。

## 日常使用和恢复

Agent 可直接调用这些工具，不依赖 PATH 上另外安装的工具：

| 工具 | 用途 |
|---|---|
| `data_safety_status` | 当前实例与当前会话的版本、指纹、计数、存储状态和覆盖边界 |
| `data_safety_snapshots` | `list` / `inspect` / `verify` / `restore`；默认恢复为旁边的新文件 |
| `data_safety_trash` | `move` / `list` / `verify` / `restore`；仅接受已核实的绝对路径，无 purge |
| `data_safety_temp` | `create` / `list` / `retire`；退休也走可恢复回收 |

没有新增逐操作确认。正常读取、编辑、依赖安装和测试继续执行。遇到不确定路径、链接、超大旧文件或不可识别写入路径时，可改用明确路径、原生编辑工具或新的版本输出，不能绕过已发生的拒绝。

默认存储为用户主目录下 `.dsh-safekeep`。它保留文件内容和原路径、时间、会话/工具标识，不记录完整对话或完整 shell 命令。**恢复数据可能含敏感内容**，不要提交到 Git。目录 ACL 限于当前账户、SYSTEM 和 Administrators。跨盘可恢复移动使用该盘按用户区分的私有库，详见[恢复手册](docs/RECOVERY.md)。没有自动清理、自动上传和加密备份。

DSH 无法启动时，从下载的同版本 tgz 解压到一个新目录，使用包内 CLI：

```powershell
node C:\DSHRecovery\package\bin\dsh-safekeep.mjs doctor
node C:\DSHRecovery\package\bin\dsh-safekeep.mjs snapshots --path C:\Work\project\notes.txt
node C:\DSHRecovery\package\bin\dsh-safekeep.mjs snapshots verify SNAPSHOT_UUID
node C:\DSHRecovery\package\bin\dsh-safekeep.mjs snapshots restore SNAPSHOT_UUID
node C:\DSHRecovery\package\bin\dsh-safekeep.mjs trash list
```

CLI 与原生工具使用同一个库，不需要 DSH 或网络。`doctor` 检查本地 CLI/存储/历史回执，明确不声称当前 DSH 已加载。完整[恢复、升级、卸载与排错](docs/RECOVERY.md)。

## 公开项目与维护

[本 GitHub 项目](https://github.com/SPX43JL/dsh-safekeep) 维护源码、文档、[issue](https://github.com/SPX43JL/dsh-safekeep/issues) 和 [Release](https://github.com/SPX43JL/dsh-safekeep/releases)。若以后在 DSH 官方社区展示，也只会链接同一项目并明确非官方；当前尚未提交社区帖子。一个包包含恢复核心和 DSH adapter，无第三方 Node 运行时依赖，不包含 Codex/Claude hook、用户配置或历史私人日志。

实现来源、参考和依赖边界见 [NOTICE](NOTICE) 与[来源记录](docs/PROVENANCE.md)。许可证为 [MIT](LICENSE)，Copyright (c) 2026 SPX43JL。支持范围和证据会随实测更新，不把测试样本通过率宣传为总体防护准确率。Windows 组件 CI 的提交结果见 [Actions](https://github.com/SPX43JL/dsh-safekeep/actions/workflows/ci.yml)。
