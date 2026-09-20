# 兼容、测试与维护

首版范围固定为 Windows 11 x64 / 本地 NTFS / Node 24.14.0 / PowerShell 7.6.5 / DSH 0.1.5-rc.2，Web 与 headless 的原生工具模式。版本是实测点，不意味着同主版本所有组合均验收。2026-09-20 npm 的 latest/next 均为 0.1.5-rc.2，alpha 为 0.1.6-alpha.2；首版不跟进 alpha 生命周期变动。DSH 仍为 developer preview。[上游 Release](https://github.com/deepseek-ai/deepseek-harness/releases)

## 源码工作流

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run test:integration
```

测试每次创建新的隔离用户/恢复目录，保留结果和样本。可通过 `DSH_SAFEKEEP_TEST_ROOT` 指定已经创建的专用实验父目录。组件测试使用实际安装的 DSH ToolRuntime、文件 observation 插件和 PTC worker；部分 shell body 是 inert，明确不冒充模型 E2E。

`scripts/check.mjs` 检查公开文件范围、常见私人信息/凭据模式、相对文档链接、JS 语法和运行时依赖。扫描不是不存在秘密或漏洞的数学证明。代码审查仍需检查 diff、最终 tgz 文件清单和源码 archive 内容。

包内恢复 CLI 无运行时第三方依赖；开发依赖必须用 lockfile 固定。`npm ci` 只能在专用开发目录使用，不要把生产 profile 当作源码工作区。CI 只执行无凭据测试，没有 publish/deploy 权限和步骤。

## 每次 DSH 升级

1. 读官方 release 与 `tools/pre-execute`、`tools.guard`、工具参数、session cwd/workdir、sandboxPolicy、bundle loader 的实际变更。
2. 在新 DSH_HOME、新恢复根中安装明确版本；运行核心、公开接口、宿主/PTC 组件负例，尤其跳过 preflight、参数变化和受限权限。
3. 对每个声明支持的入口执行真实模型 canary、两种快照恢复、回收往返、正常离线安装/测试。核对磁盘字节与审计，而非只听模型说成功。
4. 使用最终 tgz 进行干净安装、同版本重装、版本切换/回退、卸载后离线恢复；核对未修改宿主配置和其他 profile。
5. 更新精确版本矩阵、指纹、可复现的脱敏证据和已知边界，再考虑扩大声明。升级失败保留旧运行环境和失败样本。

未来可以对两个相邻明确宿主版本测试，不使用宽泛 peer semver 表达未经验证的兼容保证。本插件只做 tools API 能力检查，不能在宿主未提供可信版本服务时证明实际宿主版本；需要用户的 `dsh --version` 与入口 canary。

## 发布与恢复格式

首个版本为 **0.1.0-rc.1**，明确小范围预览，提供源码 zip、安装 tgz、SHA256SUMS、运行指纹、验收摘要和 [Release notes](RELEASE.md)。通过 [GitHub Release](https://github.com/SPX43JL/dsh-safekeep/releases) 分发 tgz，本轮不发布 npm；package 的 private/prepublishOnly 用于防止误发 npm，不表示 GitHub 源码不公开。以后若发布 npm，仍使用同一源码及版本，不能维护另一套社区专版。

快照/回收格式兼容性属于发布契约。字段新增要能读取旧数据；迁移必须保留原件、新建版本，并在 Release 说明回退限制。禁止隐式迁移旧私人 ai-data-safety 库。当前 format 兼容性的证据只覆盖本公开候选及测试 fixture，不对其他项目的恢复格式作承诺。

每次核心安全行为更改要重跑相关恢复和宿主验收；文档修正无需重复全部真实模型成本。若将来向其他宿主共享修复，按各平台单独验收和部署；本仓库暂不承担其安装入口。

## 暂不建设

全系统文件监听/驱动、自动 purge/保留策略、常驻解析服务、任意脚本解释器、云端恢复库、跨 OS 万能安装器、与其他 Agent 同步升级、全部第三方插件组合适配，均没有首版所需的收益证据。出现真实需求和可测收益再评估。
