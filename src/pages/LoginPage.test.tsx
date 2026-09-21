import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LoginPage } from './LoginPage'

const qrConfig = {
  goto: 'https://passport.feishu.cn/suite/passport/oauth/authorize?client_id=test&state=opaque',
  expiresIn: 300,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installQrSdk(options?: { originMatches?: boolean; dataMatches?: boolean }) {
  const instance = {
    matchOrigin: vi.fn(() => options?.originMatches ?? true),
    matchData: vi.fn(() => options?.dataMatches ?? true),
  }
  const qrLogin = vi.fn(({ id }: { id: string }) => {
    const iframe = document.createElement('iframe')
    iframe.title = '飞书扫码登录'
    document.getElementById(id)?.append(iframe)
    return instance
  })
  window.QRLogin = qrLogin
  return { instance, qrLogin }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete window.QRLogin
  delete window.tt
  delete window.h5sdk
  document.querySelectorAll('script[data-feishu-qr-sdk]').forEach((script) => script.remove())
  window.history.pushState({}, '', '/')
})

describe('LoginPage', () => {
  it('logs in inside Feishu without QR and preserves the meeting destination', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Lark/7.50.0')
    window.history.pushState({}, '', '/login?return_path=%2Fchat%3FconversationId%3DC1%26meetingId%3DMT-1')
    window.h5sdk = { ready: callback => callback() }
    window.tt = { requestAccess: vi.fn(options => {
      expect(options.scopeList).toEqual([])
      expect(options.appID).toBe('app-id')
      options.success({ code: 'one-time-code', state: options.state })
    }) }
    const fetchMock = vi.fn(async (path: string, init: RequestInit) => {
      if (path.startsWith('/api/auth/feishu/client-config')) return jsonResponse({ appId: 'app-id', state: 'browser-state' })
      expect(path).toBe('/api/auth/feishu/client-login')
      expect(JSON.parse(String(init.body))).toEqual({ code: 'one-time-code', state: 'browser-state' })
      return jsonResponse({ returnPath: '/chat?conversationId=C1&meetingId=MT-1' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const navigate = vi.fn()
    render(<LoginPage onQrAuthorized={navigate} />)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/chat?conversationId=C1&meetingId=MT-1'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByTitle('飞书扫码登录')).not.toBeInTheDocument()
  })

  it('keeps explicit logout idle and allows a user initiated Feishu retry', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Lark/7.50.0')
    const fetchMock = vi.fn(async () => jsonResponse({ detail: { code: 'IDENTITY_MAPPING_REQUIRED' } }, 403))
    vi.stubGlobal('fetch', fetchMock)
    render(<LoginPage automaticLoginAllowed={false} />)
    expect(screen.getByText('你已退出登录')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '使用当前飞书账号登录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('尚未开通访问权限')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('loads the Feishu QR SDK and initializes the desktop QR login', async () => {
    const { qrLogin } = installQrSdk()
    const fetchMock = vi.fn(async () => jsonResponse(qrConfig))
    vi.stubGlobal('fetch', fetchMock)

    render(<LoginPage />)

    await waitFor(() => expect(qrLogin).toHaveBeenCalledWith({
      id: 'feishu-qr-login',
      goto: qrConfig.goto,
      width: '280',
      height: '280',
      style: 'width:280px;height:280px;border:0',
    }))
    expect(screen.getByTitle('飞书扫码登录')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/feishu/qr-config?return_path=%2Fchat',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    )
  })

  it('redirects only after the SDK accepts both message origin and data', async () => {
    const { instance } = installQrSdk()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(qrConfig)))
    const onQrAuthorized = vi.fn()
    render(<LoginPage onQrAuthorized={onQrAuthorized} />)
    await screen.findByTitle('飞书扫码登录')

    fireEvent(window, new MessageEvent('message', {
      origin: 'https://passport.feishu.cn',
      data: { source: 'qrcode', tmp_code: 'temporary-code' },
    }))

    expect(instance.matchOrigin).toHaveBeenCalledWith('https://passport.feishu.cn')
    expect(instance.matchData).toHaveBeenCalledWith({ source: 'qrcode', tmp_code: 'temporary-code' })
    expect(onQrAuthorized).toHaveBeenCalledTimes(1)
    const redirectUrl = new URL(onQrAuthorized.mock.calls[0][0])
    expect(redirectUrl.searchParams.get('tmp_code')).toBe('temporary-code')
  })

  it.each([
    [{ originMatches: false }, { source: 'qrcode', tmp_code: 'temporary-code' }],
    [{ dataMatches: false }, { source: 'invalid', tmp_code: 'temporary-code' }],
    [{}, { source: 'qrcode', tmp_code: '' }],
  ])('ignores an untrusted or incomplete QR message', async (sdkOptions, data) => {
    installQrSdk(sdkOptions)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(qrConfig)))
    const onQrAuthorized = vi.fn()
    render(<LoginPage onQrAuthorized={onQrAuthorized} />)
    await screen.findByTitle('飞书扫码登录')

    fireEvent(window, new MessageEvent('message', {
      origin: 'https://untrusted.example',
      data,
    }))

    expect(onQrAuthorized).not.toHaveBeenCalled()
  })

  it('shows a retry action when the QR configuration cannot be loaded', async () => {
    installQrSdk()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(qrConfig))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<LoginPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('二维码暂时无法加载')
    await user.click(screen.getByRole('button', { name: '重新加载二维码' }))

    expect(await screen.findByTitle('飞书扫码登录')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('handles an SDK load failure without removing the direct login option', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(qrConfig)))
    render(<LoginPage />)

    const script = await waitFor(() => {
      const element = document.querySelector<HTMLScriptElement>('script[data-feishu-qr-sdk]')
      expect(element).not.toBeNull()
      return element as HTMLScriptElement
    })
    fireEvent.error(script)

    expect(await screen.findByRole('alert')).toHaveTextContent('二维码暂时无法加载')
    expect(screen.getByRole('link', { name: '使用飞书登录' })).toHaveAttribute(
      'href',
      '/api/auth/feishu/login?return_path=%2Fchat',
    )
  })

  it('shows stable Chinese feedback for a login callback failure', () => {
    installQrSdk()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(qrConfig)))
    window.history.pushState({}, '', '/login?error=FEISHU_OAUTH_STATE_INVALID')

    render(<LoginPage />)

    expect(screen.getByRole('alert')).toHaveTextContent('登录已过期，请重新开始')
    expect(document.body).not.toHaveTextContent('FEISHU_OAUTH_STATE_INVALID')
  })

  it('explains when Feishu directory permission is unavailable', () => {
    installQrSdk()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(qrConfig)))
    window.history.pushState({}, '', '/login?error=FEISHU_DIRECTORY_UNAVAILABLE')

    render(<LoginPage />)

    expect(screen.getByRole('alert')).toHaveTextContent('请联系管理员检查通讯录权限')
  })

  it('keeps the page focused on product login without technical controls', () => {
    installQrSdk()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(qrConfig)))
    render(<LoginPage />)

    expect(screen.getByRole('heading', { level: 1, name: '企业知识助手' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '使用飞书登录' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/演示身份|模型|Agent|智能体|Skill|知识库|回答范围|Factory|Knowledge Factory/iu)
    expect(document.body).not.toHaveTextContent('@')
  })
})
