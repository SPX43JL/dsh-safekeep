# 使用、恢复与故障排查

## 首次安装 canary

在实际 Web 或 headless 会话中提交以下测试。只使用新建样本，保留结果；不要拿工作文件试删。

> 调用 data_safety_status，核对 loaded、storage.ok、version、codeHash。用 data_safety_temp(action=create, label=canary) 创建目录。在其中新建 canary.txt，内容 BEFORE；read 后用 edit 改为 AFTER。调用 data_safety_snapshots(action=list, path=该文件的绝对路径)，找到 BEFORE 的快照，inspect/verify 后 restore 到默认的新文件，再 read 核对 BEFORE，原文件仍为 AFTER。对目录内从未创建的 never-created.txt，只提交一次 pwsh `Remove-Item -LiteralPath '绝对路径'`；应被拒绝，不能重试或绕过。调用 status 确认当前会话的快照和拒绝计数增加。只回收一个专门新建的第二样本：data_safety_trash(move)→verify→restore→read，核对字节。报告工具结果，不靠最后一句总结判断通过。

恢复 CLI 的位置记为 `$cli`；例如先把同版本 tgz 解压到新的 `C:\DSHRecovery\v0.1.0-rc.1`：

```powershell
# 先创建新的解压目录；不要覆盖旧版本
New-Item -ItemType Directory -Path C:\DSHRecovery\v0.1.0-rc.1
tar -xf C:\DSHPackages\dsh-safekeep-0.1.0-rc.1.tgz -C C:\DSHRecovery\v0.1.0-rc.1
$cli = 'C:\DSHRecovery\v0.1.0-rc.1\package\bin\dsh-safekeep.mjs'
node $cli doctor
```

## 覆盖恢复

```powershell
node $cli snapshots --path C:\Work\project\notes.txt
node $cli snapshots inspect SNAPSHOT_UUID
node $cli snapshots verify SNAPSHOT_UUID
node $cli snapshots restore SNAPSHOT_UUID
# 或恢复到一个尚不存在的绝对文件路径
node $cli snapshots restore SNAPSHOT_UUID --to C:\Work\project\notes-recovered.txt
# 明确需要原地恢复时：保留当前版本后恢复
node $cli snapshots restore SNAPSHOT_UUID --in-place
```

使用完整 UUID。默认文件名是原文件旁的 `.recovered-<短ID>`；目标存在时拒绝，不自动覆盖。原地恢复把当前文件保留为 `.before-restore-<UUID>`，也保存其快照。任一步失败都应保留这些文件和原库，检查错误后选择新目标，不能通过删除冲突文件“修复”。

## 可恢复移除

```powershell
node $cli trash move C:\Work\project\obsolete-output
node $cli trash list
node $cli trash verify TRANSACTION_ID
node $cli trash restore TRANSACTION_ID
node $cli trash verify TRANSACTION_ID
```

只接受一个已核实的绝对路径；根目录、用户主目录、工作目录本身、关键配置、Git 元数据、歧义/通配路径和父级链接被拒绝。移动同卷 rename，不在成功后删掉唯一原件；多卷事务不是一个全局原子事务。恢复冲突会保留原位置新内容和库中旧内容。内容损坏会拒绝恢复。

主库是 `~/.dsh-safekeep`。其他本地卷优先使用 `<卷根>/.dsh-safekeep-<用户标识摘要>/trash`；卷根无法创建时可使用源目录旁 `._dsh-safekeep-<摘要>/trash`。这些目录拥有私有 ACL，事务索引保存在主库，所以备份/容量检查不能只看 C 盘。丢失索引、手动改 manifest 或迁移到另一个账户时不应猜测恢复路径。

高级隔离测试可在启动 **DSH 和离线 CLI 两者之前**设置 `DSH_SAFEKEEP_HOME` 为专用、绝对、本地的新目录；非空且无本插件标记的目录拒绝使用。`DSH_SAFEKEEP_PWSH` 可指定 PowerShell 7 可执行文件。首版没有自动迁移旧私有 ai-data-safety 库；不要把两个库混在一起。

## 升级、回退、卸载

退出相应 profile，保留其配置/lockfile 和已验证 tgz 到新备份目录。安装新的**精确版本** tgz，重启，再验证两个入口各自的 status/指纹/canary。不要自动跟随 DSH 或插件的 latest/alpha。热重载不能代替一次干净重启。

回退时保留升级后的 profile 和恢复数据，再用同一 `dsh plugin --profile ... add <旧tgz> --save-exact --ignore-scripts --config.auto-install-peers=false` 安装明确旧版，重新核对。只有 Release 明确记录了恢复格式兼容才能这样回退；不把整个 `.dsh` 覆盖回去。

卸载使用 DSH 自己的插件管理，分别处理使用过的 profile：

```powershell
dsh plugin --profile web remove dsh-safekeep
dsh plugin --profile headless remove dsh-safekeep
```

重启后 status 工具应消失。恢复库、审计、任务目录和下载的 tgz **全部保留**。卸载后仍可用解压包内 CLI 完成 verify/restore。不要删除 `.dsh`、整棵 node_modules 或恢复库作为卸载步骤。

## 故障排查

| 现象 | 处理 |
|---|---|
| status 工具不存在 | 核对实际 profile、DSH 版本和安装命令退出码，重启。配置里有名字不代表加载 |
| `storage.ok=false` | 检查 PowerShell 7、专用存储路径、磁盘空间、链接与 ACL 错误。修正原因后重启；不要取消 guard |
| CLI doctor 无近期回执 | 可能尚未调用受检查工具、使用了另一个存储根或版本。回到当前会话运行 canary |
| AST 失败/动态路径 | 用原生 write/edit、明确字面量绝对路径或新版本输出，不执行动态表达式来猜最终路径 |
| `preflight missing/arguments changed` | 有插件跳过检查或修改参数；在新 profile 仅装本插件复现，保留原 profile，提交最小复现 |
| native recovery 权限拒绝 | 当前 policy 不是 danger-full-access；插件不自动提高权限。由用户按原有使用方式选择权限，或在会话外用 CLI |
| `another recovery operation` | 等正在执行的回收操作结束再试。不要删锁或强行并行恢复 |
| 恢复冲突/损坏 | 保留所有版本和事务资料；快照选择新的目标；先 verify，不能强制覆盖 |
| Web 401 | 用当前 DSH 启动输出的认证 URL，token 随启动改变；不要关闭认证 |

issue 只提供 OS/Node/Pwsh/DSH/插件版本、错误代码和合成样本复现。删去用户名、绝对私人路径、会话 ID、token 和文件内容；不要上传恢复库、完整配置或原始日志。CLI/status 默认输出供本机诊断，**不是自动脱敏的公开报告**。
