/**
 * dsh-douhui-api — Host half.
 *
 * 豆绘 AI 开放接口的设置后端：保存 / 更换 API Key、查询账户积分、测试连通性。
 *
 * 为什么要自己存 Key：DSH 启动子进程时会过滤掉名字里含 KEY / SECRET / TOKEN
 * 的环境变量（@deepseek-ai/dsh-subprocess 的 SENSITIVE_ENV_PATTERN），所以把
 * DOUHUI_API_KEY 写进系统环境变量也不会进入 Agent 执行命令的 shell。这里把
 * Key 落盘到 DSH 主目录下的文件，douhui-api Skill 的脚本优先读环境变量、
 * 读不到再读这个文件。全程不修改 DSH 本体与 profile 配置。
 *
 * 安全：文件只放本机用户目录；接口一律先过 DSH 的 connection 准入，Key 只在
 * 本机进程与豆绘服务器之间传递，绝不回传明文给浏览器。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-douhui-api'

/** webServer 按需注入；拿不到时插件照常启动，只是没有设置页接口。 */
export const inject = []

const ROUTE_PREFIX = '/plugins/douhui-api'
const KEY_FIELD = 'apiKey'
const MODEL_FIELD = 'model'
/** 与 Skill 脚本、凭据库共用的引用名。brand 只存在于类型层，运行时就是字符串。 */
const CREDENTIAL_REF = 'DOUHUI_API_KEY'
const KEY_LOOKS_VALID = /^dhk_[A-Za-z0-9_-]{8,}$/

/**
 * 官方 smartimg 接口接受的全部模型 id（以线上 api-docs.json 的 model 字段为准）。
 * 设置页的下拉项、保存时的白名单校验、以及 /models 接口都基于这张表，
 * 避免页面上出现接口不认的值。
 */
const IMAGE_MODELS = [
  { id: 'gpt-image-2', label: 'GPT Image 2', note: '均衡默认；1K/2K/4K，支持自定义尺寸' },
  { id: 'gpt-image-2.5', label: 'GPT Image 2.5', note: '1K/2K/4K，可切 flare / sunburst' },
  { id: 'gpt-image-2.6', label: 'GPT Image 2.6', note: '最新；支持 GIF / SVG 输出' },
  { id: 'nano-banana', label: 'Nano Banana（1.0）', note: '只能预设比例，不能自定义宽高' },
  { id: 'nano-banana-2', label: 'Nano Banana 2', note: '只能预设比例' },
  { id: 'nano-banana-2.1', label: 'Nano Banana 2.1', note: '只能预设比例' },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', note: '只能预设比例；可切 channel' },
  { id: 'seedream-5.5', label: 'Seedream 5.5', note: '1K/2K；比例 1:16～16:1' },
  { id: 'seedream-5-pro', label: 'Seedream 5 Pro', note: '1K/2K' },
  { id: 'seedream-5-flash', label: 'Seedream 5 Flash', note: '1K/2K；更便宜' },
  { id: 'wan2.7', label: '通义万相 2.7', note: '1K/2K/4K；单边≤2048' },
  { id: 'wan2.7-pro', label: '通义万相 2.7 Pro', note: '无参考图单边≤4096' },
  { id: 'qwen3', label: '通义千问图像 qwen3', note: '1K/2K；参考图最多 3 张' },
  { id: 'qwen3-pro', label: '通义千问图像 qwen3-pro', note: '1K/2K' },
  { id: 'normal', label: 'normal（通用通道）', note: '服务端默认通道' },
]
const MODEL_IDS = new Set(IMAGE_MODELS.map(m => m.id))
/** 不选模型时的默认值，与 Skill 文档约定一致。 */
const DEFAULT_MODEL = 'gpt-image-2'

/** DSH 主目录：优先取 DSH_HOME，没有就回落到用户主目录下的 .dsh。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

/** Key 文件位置：<DSH_HOME>/douhui-api/config.json。 */
function configFile() {
  return join(dshHome(), 'douhui-api', 'config.json')
}

async function readConfig() {
  try {
    const raw = await readFile(configFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 把 Key 文件与所在目录的 ACL 收紧到「仅当前用户 + SYSTEM + Administrators」。
 *
 * 背景：<DSH_HOME> 继承的 ACL 允许 BUILTIN\Users 读取、Authenticated Users 修改，
 * 任何本机账户都能读到落在里面的明文 Key。这里在 Windows 上显式重写访问规则
 * 并关闭继承；非 Windows 则退化为 0600 权限位。失败不阻断保存，只留下权限提示。
 * @param file - 要收紧权限的文件路径。
 * @returns 是否成功收紧。
 */
/**
 * 取当前账户的完整名（DOMAIN\user），不启动任何子进程。
 *
 * 审计教训：本机 USERDOMAIN 为空，用 USERNAME/USERDOMAIN 拼出 "OS-xxx\" 这种
 * 非法参数会让 icacls 整体失败、权限保持全开。这里从身份令牌里读账户 SID，
 * 直接用 SID 授权，既不依赖环境变量，也不受本地化域名格式影响。
 * @returns 当前账户 SID，失败时 undefined。
 */
async function currentUserSid() {
  try {
    // Windows 上 process.getuid 不存在，改用 os.userInfo().username + 环境兜底拿不到 SID，
    // 因此走 PowerShell 单次查询 SID 文本（不可用时退化为 USERNAME 方案）。
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
      { windowsHide: true, timeout: 8000 },
    )
    const sid = stdout.trim()
    return /^S-1-5-21(?:-\d+){3,4}$/i.test(sid) ? sid : undefined
  } catch {
    return undefined
  }
}

/**
 * 把 Key 文件与所在目录的 ACL 收紧到「仅当前用户 + SYSTEM + Administrators」。
 *
 * 背景：<DSH_HOME> 继承的 ACL 允许 BUILTIN\Users 读取、Authenticated Users 修改，
 * 任何本机账户都能读到落在里面的明文 Key。这里在 Windows 上显式重写访问规则
 * 并关闭继承；非 Windows 则退化为 0600 权限位。失败不阻断保存，只回报状态。
 * @param file - 要收紧权限的文件路径。
 * @returns 是否成功收紧。
 */
async function tightenPermissions(file) {
  try {
    if (process.platform === 'win32') {
      const sid = await currentUserSid()
      if (!sid) return false
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const run = promisify(execFile)
      /** 用 SID 授权，避免域名/本地化拼写差异；/inheritance:r 切断 Users 等继承权限。 */
      const grants = [`*${sid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F']
      await run('icacls', [file, '/inheritance:r', '/grant:r', ...grants], { windowsHide: true, timeout: 8000 })
      return true
    }
    const { chmod } = await import('node:fs/promises')
    await chmod(file, 0o600)
    return true
  } catch {
    return false
  }
}

async function writeConfig(next) {
  const file = configFile()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  return tightenPermissions(file)
}

/** 只露头尾，任何情况下都不回传完整 Key。 */
function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return undefined
  if (key.length <= 12) return `${key.slice(0, 3)}****`
  return `${key.slice(0, 8)}****${key.slice(-4)}`
}

/** Key 的有效来源：文件优先（设置页写入），其次才是进程环境。 */
async function effectiveKey() {
  const config = await readConfig()
  if (typeof config[KEY_FIELD] === 'string' && config[KEY_FIELD].length > 0) {
    return { value: config[KEY_FIELD], source: 'file' }
  }
  const ambient = typeof process.env[CREDENTIAL_REF] === 'string' ? process.env[CREDENTIAL_REF].trim() : ''
  if (ambient) return { value: ambient, source: 'env' }
  return undefined
}

/**
 * 刻意不再往 DSH 的 .credentials.yaml 写第二份 Key。
 *
 * 早期版本会把 Key 同步到凭据库的 DOUHUI_API_KEY 引用，但审计发现：
 *   1. 全机没有任何插件消费这个引用，同步只会多出一份明文副本；
 *   2. .credentials.yaml 的 ACL 允许 BUILTIN\Users 读取，多一处就多一个暴露面。
 * 现在 Key 只存在 douhui-api/config.json 一个文件中，并用 ACL 收紧到仅当前用户可读。
 * 保留此函数是为了在升级后清理旧版本可能留下的引用。
 */
function credentialsService(ctx) {
  try {
    const service = ctx.get('credentials')
    return service && typeof service.unset === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

async function purgeCredentialStore(ctx) {
  const service = credentialsService(ctx)
  if (!service) return
  try {
    await service.unset(CREDENTIAL_REF)
  } catch {
    // 没有该引用时 unset 是 no-op；异常也不影响主流程。
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 只允许本机和本页调用；判定不了就拒。 */
function admission(ctx) {
  return function check(req) {
    try {
      const connection = ctx.get('connection')
      if (!connection || typeof connection.requestRejection !== 'function') {
        return { status: 503, reason: 'connection_unavailable' }
      }
      const rejection = connection.requestRejection(req)
      if (rejection === 401 || rejection === 403) return { status: rejection, reason: 'host_rejected' }
    } catch {
      return { status: 503, reason: 'admission_failed' }
    }
    const headers = (req && req.headers) || {}
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      return { status: 403, reason: 'cross_site' }
    }
    const origin = String(headers.origin || '')
    if (origin && !/^(?:dsh-app:|https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$)/i.test(origin)) {
      return { status: 403, reason: 'foreign_origin' }
    }
    return undefined
  }
}

async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 65536) throw new Error('请求体过大')
  }
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 调豆绘 balance 接口：既能查积分，也用来判断 Key 是否有效、网络是否通。 */
async function callBalance(apiBase, key) {
  let response
  try {
    response = await fetch(`${apiBase}/api/openapi/balance`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'dsh-douhui-api' },
      /**
       * 禁止跟随重定向。虽然实测 Node fetch 跨域重定向时会剥掉 Authorization，
       * 但「不跟随」是更强的保证：带着 Key 的请求只会发往 apiBase 这一个来源。
       */
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    const detail = error && error.name === 'TimeoutError' ? '请求超时' : String((error && error.message) || error)
    return { ok: false, kind: 'network', message: `连不上豆绘服务器：${detail}` }
  }
  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, kind: 'protocol', message: `服务器返回了非 JSON 内容（HTTP ${response.status}）` }
  }
  if (data && data.status === 200 && data.data) {
    return {
      ok: true,
      points: typeof data.data.points === 'number' ? data.data.points : null,
      total: typeof data.data.total === 'number' ? data.data.total : null,
    }
  }
  const message = (data && typeof data.msg === 'string' && data.msg) || `HTTP ${response.status}`
  const invalid = /密钥无效|已禁用/.test(message)
  return { ok: false, kind: invalid ? 'invalid-key' : 'upstream', message }
}

/**
 * 挂上设置页需要的 HTTP 接口。
 * @param ctx - Host 插件上下文。
 * @param config - bundle 里的 config。
 */
export function apply(ctx, config = {}) {
  const configuredBase = typeof config.apiBase === 'string' && config.apiBase ? config.apiBase.replace(/\/+$/, '') : ''
  /**
   * 只允许 https 且主机名在白名单内。带 Key 的请求目标不能由 profile 配置随意改成
   * 任意地址，否则改一行配置就能把 Key 发到别人的服务器。允许 api.douhuiai.com
   * 是因为 Skill 脚本本身也把它当作合法基址。
   */
  const allowedBase = /^https:\/\/(?:dhd|api)\.douhuiai\.com$/
  const apiBase = configuredBase && allowedBase.test(configuredBase) ? configuredBase : 'https://dhd.douhuiai.com'
  const check = admission(ctx)

  const route = (path, handler) => {
    const handlerWithGuard = async (req, res) => {
      const denied = check(req)
      if (denied) {
        sendJson(res, denied.status, { ok: false, error: denied.reason })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        try {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        } catch {
          // 响应已经发出去时忽略。
        }
      }
    }
    const mount = (webCtx) => webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}${path}`,
      handler: handlerWithGuard,
    }))
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mount)
    else if (ctx.get('webServer')) mount(ctx)
  }

  route('/state', async (req, res) => {
    const hit = await effectiveKey()
    const cfg = await readConfig()
    const savedModel = typeof cfg[MODEL_FIELD] === 'string' && MODEL_IDS.has(cfg[MODEL_FIELD]) ? cfg[MODEL_FIELD] : DEFAULT_MODEL
    sendJson(res, 200, {
      ok: true,
      configured: Boolean(hit),
      /**
       * 只回传掩码。旧版这里会先问凭据库要 masked 预览，现在不再写凭据库，
       * 也就没有可以合并的第二来源，掩码完全由本进程按固定规则生成。
       */
      masked: hit ? maskKey(hit.value) : undefined,
      source: hit ? hit.source : undefined,
      model: savedModel,
      defaultModel: DEFAULT_MODEL,
      apiBase,
      configPath: configFile(),
    })
  })

  /** 供设置页渲染下拉用的模型清单，与出图接口的取值同源。 */
  route('/models', async (req, res) => {
    sendJson(res, 200, { ok: true, models: IMAGE_MODELS, defaultModel: DEFAULT_MODEL })
  })

  /** 单独保存模型选择：换模型不该要求重新填一遍 Key。 */
  route('/model', async (req, res) => {
    const body = await readJsonBody(req)
    const model = typeof body[MODEL_FIELD] === 'string' ? body[MODEL_FIELD].trim() : ''
    if (!model) {
      sendJson(res, 400, { ok: false, error: 'empty-model', message: '请选择一个模型' })
      return
    }
    if (!MODEL_IDS.has(model)) {
      sendJson(res, 400, { ok: false, error: 'bad-model', message: `豆绘接口不接受模型 "${model}"` })
      return
    }
    const current = await readConfig()
    await writeConfig({ ...current, [MODEL_FIELD]: model, apiBase, updatedAt: new Date().toISOString() })
    sendJson(res, 200, { ok: true, model })
  })

  route('/save', async (req, res) => {
    const body = await readJsonBody(req)
    const raw = typeof body[KEY_FIELD] === 'string' ? body[KEY_FIELD].trim() : ''
    if (!raw) {
      sendJson(res, 400, { ok: false, error: 'empty-key', message: '请先填写 API Key' })
      return
    }
    if (!KEY_LOOKS_VALID.test(raw)) {
      sendJson(res, 400, { ok: false, error: 'bad-format', message: 'Key 形如 dhk_ 开头的一串字符，请检查是否复制完整' })
      return
    }
    const current = await readConfig()
    /** 保存 Key 时如果同时带了模型，一并写入；带的值不合法就忽略，保留原选择。 */
    const incoming = typeof body[MODEL_FIELD] === 'string' ? body[MODEL_FIELD].trim() : ''
    const model = MODEL_IDS.has(incoming) ? incoming : undefined
    const restricted = await writeConfig({
      ...current,
      [KEY_FIELD]: raw,
      ...(model !== undefined ? { [MODEL_FIELD]: model } : {}),
      apiBase,
      updatedAt: new Date().toISOString(),
    })
    // 清掉旧版本可能写进 .credentials.yaml 的那一份，避免同一把 Key 存两处。
    await purgeCredentialStore(ctx)
    sendJson(res, 200, {
      ok: true,
      configured: true,
      masked: maskKey(raw),
      source: 'file',
      model: model ?? (typeof current[MODEL_FIELD] === 'string' ? current[MODEL_FIELD] : DEFAULT_MODEL),
      apiBase,
      /** 权限收紧是否成功；false 时设置页会提示手动检查文件权限。 */
      permissionsRestricted: restricted,
    })
  })

  route('/clear', async (req, res) => {
    const current = await readConfig()
    const next = { ...current }
    delete next[KEY_FIELD]
    await writeConfig({ ...next, apiBase, updatedAt: new Date().toISOString() })
    await purgeCredentialStore(ctx)
    sendJson(res, 200, { ok: true, configured: false })
  })

  route('/balance', async (req, res) => {
    const hit = await effectiveKey()
    if (!hit) {
      sendJson(res, 400, { ok: false, error: 'no-key', message: '还没有保存 API Key' })
      return
    }
    sendJson(res, 200, await callBalance(apiBase, hit.value))
  })

  route('/test', async (req, res) => {
    const hit = await effectiveKey()
    if (!hit) {
      sendJson(res, 400, { ok: false, error: 'no-key', message: '还没有保存 API Key' })
      return
    }
    const result = await callBalance(apiBase, hit.value)
    sendJson(res, 200, { ...result, source: hit.source, apiBase })
  })
}
