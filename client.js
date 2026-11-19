/**
 * dsh-douhui-api — Client half.
 *
 * 在「设置」里加一个「豆绘 API」页：填 Key、保存、查询积分、测试连通性。
 * 用 DSH 官方的 settings.section 槽位，样式走主题变量，不覆盖任何原生界面。
 * 所有读写都经 Host 路由 /plugins/douhui-api/*，浏览器永远拿不到完整 Key。
 * No build step: DSH loads this file as a Cordis client bundle via dsh.client.
 */
window.__ModuleLoader__.load({
  id: 'dsh-douhui-api',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const ID = 'dsh-douhui-api'
    const API = '/plugins/douhui-api'
    const SECTION_ID = 'douhui-api'

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13 },
      card: {
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.22))',
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      h: { fontSize: 13, fontWeight: 600 },
      dim: { color: 'var(--dsw-alias-label-tertiary, #8a8a8a)', fontSize: 12, lineHeight: 1.6 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 240px',
        minWidth: 180,
        padding: '7px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.32))',
        background: 'var(--dsw-alias-bg-primary, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      btn: {
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.32))',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,0.12))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
        fontSize: 13,
      },
      primary: { background: 'var(--dsw-alias-brand-primary, #247bbf)', borderColor: 'transparent', color: '#fff' },
      ok: { color: 'var(--dsw-alias-state-success, #2e9e5b)', fontSize: 12 },
      bad: { color: 'var(--dsw-alias-state-error, #d14343)', fontSize: 12 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11.5,
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,0.14))',
      },
      dot: { width: 6, height: 6, borderRadius: 999 },
      link: { color: 'var(--dsw-alias-label-secondary, #6d9dc5)', textDecoration: 'none' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11.5,
        wordBreak: 'break-all',
      },
    }

    async function request(path, options) {
      const response = await fetch(API + path, { cache: 'no-store', ...options })
      let data
      try {
        data = await response.json()
      } catch {
        data = { ok: false, message: `服务器返回了非 JSON 内容（HTTP ${response.status}）` }
      }
      return data || {}
    }

    function statusBadge(state) {
      if (!state) return null
      const on = Boolean(state.configured)
      return h(
        'span',
        { style: S.badge },
        h('span', { style: { ...S.dot, background: on ? '#2e9e5b' : '#c9a227' } }),
        on ? `已配置 · ${state.masked || '已保存'}` : '未配置',
      )
    }

    function DouhuiCard() {
      const [state, setState] = useState(null)
      const [models, setModels] = useState([])
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [balance, setBalance] = useState(null)

      const loadState = useCallback(async () => {
        try {
          setState(await request('/state'))
        } catch (error) {
          setState({ ok: false, message: String((error && error.message) || error) })
        }
      }, [])

      const loadModels = useCallback(async () => {
        try {
          const result = await request('/models')
          if (result && Array.isArray(result.models)) setModels(result.models)
        } catch {
          // 模型清单拉不到时下拉退化为空，不影响 Key 保存。
        }
      }, [])

      useEffect(() => {
        loadState()
        loadModels()
      }, [loadState, loadModels])

      /** 换模型立即落盘，不要求重新填 Key。 */
      const chooseModel = async (model) => {
        setBusy('model')
        setNotice(null)
        try {
          const result = await request('/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model }),
          })
          if (result.ok) {
            setState((prev) => ({ ...(prev || {}), model: result.model }))
            setNotice({ ok: true, text: `默认出图模型已切换为 ${result.model}。` })
          } else {
            setNotice({ bad: true, text: result.message || '切换失败' })
          }
        } catch (error) {
          setNotice({ bad: true, text: String((error && error.message) || error) })
        } finally {
          setBusy('')
        }
      }

      const save = async () => {
        const key = draft.trim()
        if (!key) {
          setNotice({ bad: true, text: '请先填写 API Key' })
          return
        }
        setBusy('save')
        setNotice(null)
        try {
          const result = await request('/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: key }),
          })
          if (result.ok) {
            setDraft('')
            setNotice({ ok: true, text: '已保存。Agent 现在就能直接调用豆绘接口了。' })
            setBalance(null)
            await loadState()
          } else {
            setNotice({ bad: true, text: result.message || '保存失败' })
          }
        } catch (error) {
          setNotice({ bad: true, text: String((error && error.message) || error) })
        } finally {
          setBusy('')
        }
      }

      const clear = async () => {
        setBusy('clear')
        setNotice(null)
        setBalance(null)
        try {
          const result = await request('/clear', { method: 'POST' })
          if (result.ok) setNotice({ ok: true, text: '已清除本机保存的 Key。' })
          else setNotice({ bad: true, text: result.message || '清除失败' })
          await loadState()
        } catch (error) {
          setNotice({ bad: true, text: String((error && error.message) || error) })
        } finally {
          setBusy('')
        }
      }

      const query = async (path, kind) => {
        setBusy(kind)
        setNotice(null)
        try {
          const result = await request(path, { method: 'POST' })
          if (result.ok) {
            setBalance({ points: result.points, total: result.total })
            if (kind === 'test') {
              setNotice({ ok: true, text: `连接正常，Key 有效（来源：${result.source === 'env' ? '环境变量' : '本机保存'}）。` })
            }
          } else {
            setBalance(null)
            setNotice({ bad: true, text: result.message || '调用失败' })
          }
        } catch (error) {
          setBalance(null)
          setNotice({ bad: true, text: String((error && error.message) || error) })
        } finally {
          setBusy('')
        }
      }

      const configured = state && state.configured
      const currentModel = (state && state.model) || (state && state.defaultModel) || ''
      const currentMeta = models.find((m) => m.id === currentModel)

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.card },
          h('div', { style: S.row }, h('span', { style: S.h }, '豆绘 AI 接口'), statusBadge(state)),
          h(
            'div',
            { style: S.dim },
            '填一次 Key，Agent 就能直接调用豆绘的图像 / 视频接口（智能出图、万能改图、图片编辑器等）。Key 存在本机 D 盘，不上传、不回显明文。',
          ),
          h(
            'div',
            { style: S.row },
            h('input', {
              style: S.input,
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: configured ? '粘贴新的 Key 可替换当前的' : 'dhk_ 开头的 API Key',
              value: draft,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') save()
              },
            }),
            h('button', { style: { ...S.btn, ...S.primary }, disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存'),
            configured
              ? h('button', { style: S.btn, disabled: busy === 'clear', onClick: clear }, busy === 'clear' ? '清除中…' : '清除')
              : null,
          ),
          h(
            'div',
            { style: S.dim },
            'Key 在 ',
            h('a', { style: S.link, href: 'https://www.douhuiai.com/developer/keys', target: '_blank', rel: 'noreferrer' }, '豆绘 API 密钥页'),
            ' 创建。1 元 = 100 积分，按模型规格扣费。',
          ),
          notice ? h('div', { style: notice.bad ? S.bad : S.ok }, notice.text) : null,
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.h }, '出图模型'),
            h('span', { style: { ...S.dim, marginLeft: 2 } }, currentModel ? `当前：${currentModel}` : ''),
          ),
          h(
            'div',
            { style: S.dim },
            '选好的模型会成为默认值：Agent 调用智能出图时优先用它。单次请求仍可临时指定别的模型。',
          ),
          h(
            'div',
            { style: S.row },
            h(
              'select',
              {
                style: { ...S.input, flex: '1 1 280px', cursor: 'pointer' },
                value: currentModel,
                disabled: busy === 'model' || models.length === 0,
                onChange: (event) => chooseModel(event.target.value),
              },
              models.length === 0
                ? h('option', { value: '' }, '加载中…')
                : models.map((m) => h('option', { key: m.id, value: m.id }, `${m.label}  ·  ${m.id}`)),
            ),
          ),
          currentMeta ? h('div', { style: S.dim }, currentMeta.note) : null,
          h(
            'div',
            { style: S.dim },
            '参考：1 元 = 100 积分；分辨率越高、模型越强，单张扣费越多。查看 ',
            h('a', { style: S.link, href: 'https://www.douhuiai.com/developer/pricing', target: '_blank', rel: 'noreferrer' }, '定价目录'),
            ' 了解各模型单价。',
          ),
        ),

        h(
          'div',
          { style: S.card },
          h('div', { style: S.row }, h('span', { style: S.h }, '账户'),
            h('button', { style: S.btn, disabled: !configured || busy === 'balance', onClick: () => query('/balance', 'balance') },
              busy === 'balance' ? '查询中…' : '查询积分'),
            h('button', { style: S.btn, disabled: !configured || busy === 'test', onClick: () => query('/test', 'test') },
              busy === 'test' ? '测试中…' : '测试连通性'),
          ),
          balance
            ? h(
                'div',
                { style: S.row },
                h('span', { style: S.h, fontSize: 20 }, String(balance.points ?? '—')),
                h('span', { style: S.dim }, '积分'),
                balance.total != null ? h('span', { style: S.dim }, `· 累计充值 ${balance.total}`) : null,
              )
            : h('div', { style: S.dim }, configured ? '点上面的按钮查看当前可用积分。' : '保存 Key 后可以查询积分与测试连通性。'),
        ),

        state && state.configPath
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.h }, '本机信息'),
              h('div', { style: S.dim }, '接口地址：', h('span', { style: S.code }, String(state.apiBase || 'https://dhd.douhuiai.com'))),
              h('div', { style: S.dim }, 'Key 文件：', h('span', { style: S.code }, String(state.configPath))),
              h(
                'div',
                { style: S.dim },
                'Agent 侧用法：说「用豆绘画一张……」即可；也可以直接跑 ',
                h('span', { style: S.code }, 'python %DSH_HOME%\\skills\\douhui-api\\scripts\\douhui_api.py catalog'),
                ' 查看全部接口。',
              ),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        // 设置页不存在（例如只跑无界面 profile）时安静跳过，不让插件起不来。
        try {
          slots.inject('settings.section', () =>
            slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: 62,
                label: () => '豆绘 API',
              },
              DouhuiCard,
            ),
          )
        } catch (error) {
          console.error('[douhui-api] 设置页注册失败，插件其余部分不受影响', error)
        }
      },
    }
  },
})
