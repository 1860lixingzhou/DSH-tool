# dsh-safety-guard

DSH 安全限制插件。装进一个 profile 后，在**完全权限（`danger-full-access`）**会话里做三件事：

1. **给 DSH 生成的文件打标记** —— 在文件结尾追加一行 `[DSH-GENERATED]` 注释（按扩展名选注释语法，如 `#`、`//`、`<!-- -->`），JSON 和二进制等不能加注释的格式跳过。
2. **让 DSH 能分辨「自己写的」和「用户下载的」** —— 每次成功写入后把文件登记进 `D:\DSH备份\origin.json`，并提供 `dsh_file_origin` 工具查询来源。
3. **改/删旧文件前先备份** —— 在完全权限下，`write`/`edit`/`str_replace_editor` 命中**已存在**的文件时，先把旧文件复制到 `D:\DSH备份\files\<日期>\...`；`bash`/`pwsh` 里出现删除类命令时，先把整个工作区快照到 `D:\DSH备份\snap\<时间戳>\`。

## 安装

```powershell
# 装进 desktop profile（写操作需在 DSH 完全退出后执行）
dsh plugin --profile desktop add '<本目录的绝对路径>'
```

装完后**重启 DeepSeek Harness**，Host 插件才会加载。`--dump-config` 对 desktop profile 被 Electron 独占禁止，属正常限制。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `dsh-safety-guard` 行的 `config`（插件零外部依赖，不声明 schemastery `Config`；配置由 `normalizeConfig` 防御式归一化，缺省/类型不对都会回落到默认值）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `backupRoot` | `D:\DSH备份` | 备份根目录（旧文件 + 快照 + origin 登记） |
| `backupInModes` | `['danger-full-access']` | 哪些沙箱模式下触发改前备份 |
| `markEnabled` | `true` | 是否给写入的文件加结尾标记 |
| `snapshotBeforeShellDelete` | `true` | 删除类 shell 命令前是否快照工作区 |
| `maxSnapshotBytes` | `268435456`（256 MiB） | 快照体积上限；超过则拒绝该删除命令 |
| `markMaxFileBytes` | `8388608`（8 MiB） | 超过此大小的文件不加标记（仍登记） |

> `backupRoot` 默认是 Windows 路径（`D:\DSH备份`），可用上面的配置项覆盖；非 Windows 环境请显式设置。

## 来源识别

- 文件结尾的 `[DSH-GENERATED]` 行是最直接的证据（`grep` 即可）。
- `D:\DSH备份\origin.json` 记录每个 DSH 写过的绝对路径、sha256、时间、工具名。
- 调 `dsh_file_origin({ path })` 得到 `origin: dsh|unknown`、`marked`、`registered`。

## 已知边界

- 只覆盖第一方文件工具（`write`/`edit`/`mutating str_replace_editor`）和 `bash`/`pwsh` 的删除类命令；其它写入方式不在拦截范围内。
- `.json` 不能加注释，只做登记；二进制文件同样只登记。
- shell 删除前快照的是**整个会话工作区**，不是精确目标；工作区超过 `maxSnapshotBytes` 时会拒绝该命令（安全优先）。
- 删除/修改**工作区之外**的文件：修改会精确备份；删除只能靠工作区快照，覆盖不到。

## 开发验证

```powershell
# 纯逻辑 + mock ctx 接线测试（无需 DSH）
node test/simulate.js
```

`test/simulate.js` 覆盖：标记语法与幂等、JSON/二进制跳过、模式门控、改前备份、删除前快照、origin 工具查询。
