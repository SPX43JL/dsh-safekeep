# 0.1.0-rc.1 验收记录

本地完整验收日期：2026-09-20。Windows 11 x64（build 26200）、本地 NTFS、Node 24.14.0、PowerShell 7.6.5、DSH 0.1.5-rc.2。下表真实模型证据来自公开准备候选，指纹为 `323590be77de5bbac64bcb9475980e2f8ee6675b978f1b817c3759ee52706b0e`。

首次公开补全了 GitHub 元数据、MIT/SPX43JL 署名和发布文档，`lib/`、`bin/`、`dsh-plugin.mjs`、`cordis.patch.yml` 保持候选原字节。package.json 参与指纹，正式分发的 codeHash 因元数据变为 `d001538995f019022947cc84de4d87fa7f4316e3d3d916ae33a4072d7c66c5a9`。最终产物安装/恢复核对见 Release 的 `ARTIFACT-VALIDATION.json`；精确提交的 Windows 云 CI 见 [Actions](https://github.com/SPX43JL/dsh-safekeep/actions/workflows/ci.yml) 和 `ACCEPTANCE-SUMMARY.json`。不要把候选模型会话说成是在新元数据指纹下执行。

## 证据分层

| 层次 | 结果 | 证明范围 |
|---|---|---|
| 核心恢复/路径测试 | 66/66 | 旧字节、冲突、损坏、链接、64 MiB 上限、中断恢复、跨进程锁与退出释放 |
| 新公开接口与存储测试 | 12/12 | 独立 CLI、跨进程 ACL、非空陌生目录拒绝、注册任务往返、严格参数、状态不冒充加载 |
| 实际 DSH 组件 | 30/30 | 真 ToolRuntime、文件/observation；inert shell；跳过 preflight、异步改参、受限 policy 拒绝、full-access 原生恢复 |
| 实际 PTC worker 组件 | 3/3 | 经 registry 分发的嵌套读改写有快照，删除在 shell body 前拒绝；合成 session，无模型 |
| 实际 ToolRuntime 启动故障 | 3/3 | 新存储故意缺失 PowerShell；早期写调用拒绝、旧文件不变、status 仍能明确报告存储失败 |
| 新安装包生命周期 | 6/6 | 同版重装、版本切换、回退指纹、卸载后离线恢复、另一 profile/模型设置字节未变 |
| 跨本地卷回收 | 通过 | D 盘新样本、C 盘索引；同卷 rename、verify/restore 字节一致，私有 DACL 仅当前用户/SYSTEM/Administrators |
| headless 真模型 | 35 calls，32 checks，1 预期拒绝 | 3 自动快照 + 1 原地恢复保护快照；默认新文件恢复、原地恢复、回收往返、离线 npm install/npm test |
| Web 真模型 | 40 calls，37 checks，1 预期拒绝 | 3 自动快照 + 1 原地恢复保护快照；指定新目标恢复、原地恢复、回收往返、离线 npm install/npm test |

两个模型入口分别安装实际 tgz，使用新 DSH_HOME、新用户目录与恢复根，宿主通过全新 npm 安装取得；包内不依赖原电脑的全局恢复 CLI。沿用用户已有模型提供方认证，只在进程环境使用，没有复制进公开目录。

每个模型入口仅有一次预期错误（从未创建路径的删除拒绝），没有其他工具错误。每个匹配的 read/write/edit/pwsh 调用都有同 call ID 的真实回执。原始字节、SHA-256、恢复目的文件和较新版本保留副本均独立核对；npm 退出结果从实际 tool/result 提取，模型总结不作为通过依据。

Web 原生文件操作使用绝对路径指向新样本目录；session cwd 保持已有隔离 workspace，另用 pwsh workdir 检查目标解析。Web 实际指定了新恢复目标，默认新文件恢复由 headless 和核心测试证明。界面显示 full access，session 记录也是 danger-full-access；插件未新增确认。无认证 HTTP 请求为 401，Web 仅监听回环。

## 失败记录与修正

- 候选开发中曾用上游 Cordis 不支持的 required/optional inject 形态，组件暴露插件未加载；改回已验证的服务列表。新增 guard 同步注册，避免异步存储初始化成为可执行工具前的空窗。
- Windows 首版 ACL 设置在第二个进程报 SeSecurityPrivilege；改为对 DACL 使用 .NET 文件系统 ACL API，再由新 CLI 进程复验。
- 扩展组件测试曾错误修改宿主冻结的 arguments 内部对象；改为替换执行参数对象以真实测试相同分发阶段的改参拒绝。
- Web 模型总结把指定新路径恢复叫作默认恢复；独立采集器发现并纠正，演示摘要随之修正。
- 所有失败实验保留在本地私有测试空间，不把其失败退出计为通过。

## 限制

上述本地模型验收使用同一台 Windows 电脑上的新目录/新配置/新安装，**不是新虚拟机、另一物理机或另一 Windows 账户**。PATH 中的 Node、PowerShell、pnpm 仍来自该电脑。Windows 云 CI 是另一份无模型凭据的组件证据，不能替代真实 Web/headless 会话或扩展支持范围。跨盘库的“卷根权限拒绝→源目录旁回退”分支未强制实机触发。不声称多日无人值守、整机断电、所有磁盘满场景或所有插件组合验证。

版本切换用同一核心、仅改变版本号的本地 fixture，证明安装流程和保留数据，不证明未来代码版本兼容。PTC 组件不等于真实模型/Web PTC E2E。测试计数不是总体拦截率或安全准确率。

完整会话、用户名、API 凭据、Web token、绝对私人路径和恢复库不公开。附件中的独立验收 JSON 只包含以上有限统计与判断。发布脚本按允许清单生成源码，并再次检查最终包内容。
