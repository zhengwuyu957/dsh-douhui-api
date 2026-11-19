# v1.0.0 — 首个公开版本

豆绘 AI 开放接口的 DSH 设置卡。在 **设置 → 豆绘 API** 里填一次 API Key，Agent 就能直接调用豆绘的出图、改图、视频等接口。

## 为什么需要它

DSH 启动子进程时会过滤掉名字里含 `KEY` / `SECRET` / `TOKEN` 的环境变量（`@deepseek-ai/dsh-subprocess` 的 `SENSITIVE_ENV_PATTERN`），所以把 `DOUHUI_API_KEY` 加进系统环境变量**不会**进入 Agent 执行命令的 shell。

这个插件把 Key 存进 DSH 主目录下的文件，并让 `douhui-api` Skill 的脚本优先读环境变量、读不到再读这个文件，从此不依赖环境变量。

## 功能

- **保存 / 更换 Key**：在设置页粘贴 `dhk_...` 密钥，一次性配置
- **出图模型下拉**：15 个模型与豆绘线上 `api-docs.json` 的 `model` 取值同源，换模型立即生效，不用重填 Key
- **查询积分**：调 `/api/openapi/balance` 显示账户余额
- **测试连通性**：确认 Key 有效、网络可达
- **本机信息**：接口地址与 Key 文件路径直接显示在设置页，排查问题时不用翻文档

## 模型选择怎么起作用

选中的模型存进同一个 `config.json` 的 `model` 字段。`douhui-api` 技能脚本提交任务时按两条规则决定是否补 `model`：

- 该接口**声明了** `model` 字段，**且**取值说明里**包含**你选的模型 → 自动补上
- 否则原样不动（例如余额查询、裁剪这类不接受模型的接口）

自己显式指定了 `model` 的请求不会被覆盖。

可选模型：

`gpt-image-2`、`gpt-image-2.5`、`gpt-image-2.6`、`nano-banana`、`nano-banana-2`、`nano-banana-2.1`、`nano-banana-pro`、`seedream-5.5`、`seedream-5-pro`、`seedream-5-flash`、`wan2.7`、`wan2.7-pro`、`qwen3`、`qwen3-pro`、`normal`

## 安全设计

- **Key 只存一处**：`<DSH_HOME>/douhui-api/config.json`。早期版本会往 `.credentials.yaml` 同步一份引用，审计确认全机没有任何插件消费该引用、而该文件 ACL 允许本机所有用户读取，因此已移除同步逻辑，升级后还会主动清除旧版本可能留下的引用
- **文件 ACL 收紧**：保存时用 `icacls /inheritance:r` 把 Key 文件权限改为仅「当前账户 + SYSTEM + Administrators」，切断 `BUILTIN\Users` / `Authenticated Users` 的继承权限。设置页返回的 `permissionsRestricted` 字段表示是否成功
- **不回显明文**：设置页接口只回传掩码预览（如 `dhk_abcd****wxyz`）
- **不跟随重定向**：请求带 `redirect: 'error'`，带 Key 的请求只会发往固定的豆绘域名
- **出站地址白名单**：`config.apiBase` 只接受 `https://dhd.douhuiai.com` 或 `https://api.douhuiai.com`，改成其他地址会回落到默认值
- **不写日志**：Host 代码不含任何 `console` / `logger` 调用，Key 不会进入 DSH 日志或会话记录

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/plugins/douhui-api/state` | 当前是否已配置、掩码、来源、默认模型、接口地址、Key 文件路径 |
| GET | `/plugins/douhui-api/models` | 可供下拉选择的模型清单 |
| POST | `/plugins/douhui-api/model` | 单独保存默认模型 |
| POST | `/plugins/douhui-api/save` | 保存 / 更换 Key，可同时带 `model` |
| POST | `/plugins/douhui-api/clear` | 清除本机保存的 Key |
| POST | `/plugins/douhui-api/balance` | 查询账户积分 |
| POST | `/plugins/douhui-api/test` | 测试连通性与 Key 有效性 |

## 依赖

需要先装 `douhui-api` 技能（提供 `scripts/douhui_api.py`）。插件本身不打包技能，只负责把 Key 安全地放到技能能读到的地方。

## 兼容性

- DSH：桌面版 / Web 版均可，`settings.section` 槽位注册设置页
- Node.js >= 22
- 关闭插件后，设置页与以上接口消失；已保存的 Key 文件仍在，重新启用后继续生效。Skill 脚本本身不受影响，只是没有 Key 时会返回 `MISSING_API_KEY`
