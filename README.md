# dsh-douhui-api

豆绘 AI 开放接口的 DSH 设置卡。在 **设置 → 豆绘 API** 里填一次 API Key，Agent 就能直接调用豆绘的接口。

## 为什么需要它

DSH 启动子进程时会过滤掉名字里含 `KEY` / `SECRET` / `TOKEN` 的环境变量（`@deepseek-ai/dsh-subprocess` 的 `SENSITIVE_ENV_PATTERN`），所以把 `DOUHUI_API_KEY` 加进系统环境变量**不会**进入 Agent 执行命令的 shell。这个插件把 Key 存在 DSH 主目录下的文件里，并让 `douhui-api` Skill 的脚本优先读环境变量、读不到再读这个文件，从而不再依赖环境变量。

## 安装

需要 DSH 已装好，并且装了 `douhui-api` 技能（本插件只负责存 Key，调接口的脚本在技能里）。

```sh
git clone https://github.com/zhengwuyu957/dsh-douhui-api.git
```

然后在 DSH 里用 Plugin Manager 装这个目录（**Plugins → Add plugin**，选仓库目录，或在会话里让 Agent 装）：

```js
pluginManager.install_bundle({ action: 'install_bundle', target: '<仓库绝对路径>' })
```

装完**完全退出 DSH 再打开**——`index.js` 是 Host 侧代码，要重启才加载；之后只改 `client.js` 的话刷新页面就够。

### Windows 跨盘符注意

若仓库与 DSH profile 不在同一个磁盘分区，pnpm 会生成失效的相对符号链接，表现为安装成功但插件解析不到。把 profile 里的链接换成 junction：

```powershell
$link = "$env:DSH_PROFILE_DIR\node_modules\dsh-douhui-api"
(Get-Item $link).Delete()
New-Item -ItemType Junction -Path $link -Value "<仓库绝对路径>"
```

## 使用

1. 装好 bundle 后打开 **设置 → 豆绘 API**。
2. 在 [豆绘 API 密钥页](https://www.douhuiai.com/developer/keys) 创建 `dhk_...` 密钥，粘贴进输入框，点 **保存**。
3. 在 **出图模型** 下拉里选默认模型（换模型立即生效，不需要重新填 Key）。
4. **查询积分** / **测试连通性** 可以确认 Key 有效、网络可达。
5. 对 Agent 说「用豆绘画一张……」，或让 Agent 加载 `douhui-api` 技能。

### 模型选择是怎么起作用的

选中的模型存进同一个 `config.json` 的 `model` 字段。`douhui-api` 技能脚本在提交任务时按两条规则决定是否补 `model`：

- 该接口**声明了** `model` 字段，**且** 它的取值说明里**包含**你选的模型 → 自动补上
- 否则原样不动（例如余额查询、裁剪这类不接受模型的接口）

自己显式指定了 `model` 的请求不会被覆盖。这样既能让「默认用我的模型」生效，又不会给不支持该模型的接口硬塞字段导致报错。

可选的 15 项与豆绘线上 `api-docs.json` 的 `model` 取值同源：

`gpt-image-2`、`gpt-image-2.5`、`gpt-image-2.6`、`nano-banana`、`nano-banana-2`、`nano-banana-2.1`、`nano-banana-pro`、`seedream-5.5`、`seedream-5-pro`、`seedream-5-flash`、`wan2.7`、`wan2.7-pro`、`qwen3`、`qwen3-pro`、`normal`。

## 存了什么、存在哪

| 项目 | 位置 |
|---|---|
| Key 文件 | `<DSH_HOME>/douhui-api/config.json`（桌面版即 `%USERPROFILE%\.dsh\douhui-api\config.json` 对应实体） |

Key 全文只在本机 Host 进程与豆绘服务器之间传递；设置页接口只回传掩码预览（如 `dhk_abcd****wxyz`），不会回传明文。设置页的 HTTP 接口先过 DSH 的 connection 准入，跨站与外来 Origin 一律拒绝。

### Key 的防护措施

- **只存一处**：早期版本会往 `<DSH_HOME>/.credentials.yaml` 同步一份 `DOUHUI_API_KEY` 引用。审计发现全机没有任何插件消费该引用，而该文件 ACL 允许本机所有用户读取，因此已移除同步逻辑；升级后还会主动清除旧版本可能留下的引用。
- **文件 ACL 收紧**：保存时用 `icacls /inheritance:r` 把 Key 文件权限改为仅「当前账户 + SYSTEM + Administrators」，切断 `BUILTIN\Users` / `Authenticated Users` 的继承权限。设置页返回的 `permissionsRestricted` 字段表示是否成功；为 `false` 时会提示手动检查。
- **不跟随重定向**：请求带 `redirect: 'error'`，带 Key 的请求只会发往固定的豆绘域名。
- **出站地址白名单**：`config.apiBase` 只接受 `https://dhd.douhuiai.com` 或 `https://api.douhuiai.com`，改成其他地址会回落到默认值，避免改一行配置就把 Key 发到别处。
- **不写日志**：Host 代码不含任何 `console` / `logger` 调用，Key 不会进入 DSH 日志或会话记录。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/plugins/douhui-api/state` | 当前是否已配置、掩码、来源、默认模型、接口地址、Key 文件路径 |
| GET | `/plugins/douhui-api/models` | 可供下拉选择的模型清单（与出图接口取值同源） |
| POST | `/plugins/douhui-api/model` | 单独保存默认模型，body `{"model":"qwen3-pro"}` |
| POST | `/plugins/douhui-api/save` | 保存 / 更换 Key，body `{"apiKey":"dhk_..."}`，可同时带 `model` |
| POST | `/plugins/douhui-api/clear` | 清除本机保存的 Key |
| POST | `/plugins/douhui-api/balance` | 查询账户积分（调豆绘 `/api/openapi/balance`） |
| POST | `/plugins/douhui-api/test` | 测试连通性与 Key 有效性 |

## 关闭插件会怎样

设置页和以上接口消失；已保存的 Key 文件和凭据引用仍在，重新启用后继续生效。Skill 脚本本身不受影响，只是没有可用的 Key 时会返回 `MISSING_API_KEY`。
