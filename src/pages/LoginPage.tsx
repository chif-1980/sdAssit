import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Smartphone,
} from 'lucide-react'

import type { FeishuQrLoginConfig } from '../../shared/api/product'
import { api, ApiError } from '../api/client'
import { feishuClientErrorMessage, isFeishuClient, requestFeishuCode } from '../session/feishuClient'
import { safeReturnPath } from '../session/returnPath'

const QR_SDK_URL = 'https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js'

type QrLoginStatus = 'loading' | 'ready' | 'scanned' | 'error'

interface QrLoginInstance {
  matchOrigin(origin: string): boolean
  matchData(data: unknown): boolean
}

interface QrLoginOptions {
  id: string
  goto: string
  width: string
  height: string
  style: string
}

type QrLoginFactory = (options: QrLoginOptions) => QrLoginInstance

declare global {
  interface Window {
    QRLogin?: QrLoginFactory
  }
}

interface LoginPageProps {
  onQrAuthorized?: (url: string) => void
  automaticLoginAllowed?: boolean
}

const loginErrorMessages: Record<string, string> = {
  AUTH_SERVICE_UNAVAILABLE: '登录服务暂时不可用，请稍后重试',
  FEISHU_OAUTH_FAILED: '飞书登录未完成，请重新尝试',
  FEISHU_OAUTH_NOT_CONFIGURED: '登录服务尚未配置，请联系管理员',
  FEISHU_OAUTH_STATE_INVALID: '登录已过期，请重新开始',
  FEISHU_DIRECTORY_UNAVAILABLE: '无法读取飞书组织信息，请联系管理员检查通讯录权限',
  IDENTITY_MAPPING_REQUIRED: '当前飞书账号尚未开通访问权限',
}

function defaultQrAuthorized(url: string) {
  window.location.assign(url)
}

function loadQrSdk(): Promise<QrLoginFactory> {
  if (window.QRLogin) return Promise.resolve(window.QRLogin)

  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-feishu-qr-sdk]')
    const script = existingScript ?? document.createElement('script')

    const removeListeners = () => {
      script.removeEventListener('load', handleLoad)
      script.removeEventListener('error', handleError)
    }
    const handleLoad = () => {
      removeListeners()
      if (window.QRLogin) {
        resolve(window.QRLogin)
        return
      }
      reject(new Error('Feishu QR SDK did not initialize'))
    }
    const handleError = () => {
      removeListeners()
      script.remove()
      reject(new Error('Feishu QR SDK failed to load'))
    }

    script.addEventListener('load', handleLoad)
    script.addEventListener('error', handleError)
    if (!existingScript) {
      script.src = QR_SDK_URL
      script.async = true
      script.dataset.feishuQrSdk = 'true'
      document.head.append(script)
    }
  })
}

export function LoginPage({ onQrAuthorized = defaultQrAuthorized, automaticLoginAllowed = true }: LoginPageProps) {
  const [inFeishu] = useState(isFeishuClient)
  const [clientStatus, setClientStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [clientError, setClientError] = useState('')
  const returnPath = safeReturnPath(new URLSearchParams(window.location.search).get('return_path'))
  const loginQuery = `return_path=${encodeURIComponent(returnPath)}`
  const [qrStatus, setQrStatus] = useState<QrLoginStatus>('loading')
  const [retryKey, setRetryKey] = useState(0)
  const callbackError = useMemo(() => {
    const errorCode = new URLSearchParams(window.location.search).get('error')
    return errorCode ? loginErrorMessages[errorCode] ?? '登录未完成，请重新尝试' : null
  }, [])

  useEffect(() => {
    if (!inFeishu || (!automaticLoginAllowed && retryKey === 0)) return
    let disposed = false
    const controller = new AbortController()
    const login = async () => {
      setClientStatus('loading')
      try {
        const config = await api<{ appId: string; state: string }>(`/api/auth/feishu/client-config?${loginQuery}`, {
          signal: controller.signal, cache: 'no-store',
        })
        if (disposed) return
        const code = await requestFeishuCode(config.appId, config.state)
        if (disposed) return
        const result = await api<{ returnPath: string }>('/api/auth/feishu/client-login', {
          method: 'POST', body: JSON.stringify({ code, state: config.state }), signal: controller.signal,
        })
        if (!disposed) onQrAuthorized(safeReturnPath(result.returnPath))
      } catch (error) {
        if (disposed) return
        setClientError(error instanceof ApiError
          ? loginErrorMessages[error.code] ?? '飞书登录失败，请重试或联系管理员'
          : feishuClientErrorMessage(error))
        setClientStatus('error')
      }
    }
    void login()
    return () => { disposed = true; controller.abort() }
  }, [automaticLoginAllowed, inFeishu, loginQuery, onQrAuthorized, retryKey])

  useEffect(() => {
    if (inFeishu) return
    const abortController = new AbortController()
    let disposed = false
    let expiryTimer: number | undefined
    let messageHandler: ((event: MessageEvent) => void) | undefined

    setQrStatus('loading')
    document.getElementById('feishu-qr-login')?.replaceChildren()

    const initializeQrLogin = async () => {
      try {
        const [config, qrLoginFactory] = await Promise.all([
          api<FeishuQrLoginConfig>(`/api/auth/feishu/qr-config?${loginQuery}`, {
            signal: abortController.signal,
            cache: 'no-store',
          }),
          loadQrSdk(),
        ])
        if (disposed) return
        if (!config.goto || !Number.isFinite(config.expiresIn) || config.expiresIn <= 0) {
          throw new Error('Invalid QR configuration')
        }

        const qrLogin = qrLoginFactory({
          id: 'feishu-qr-login',
          goto: config.goto,
          width: '280',
          height: '280',
          style: 'width:280px;height:280px;border:0',
        })

        messageHandler = (event: MessageEvent) => {
          if (!qrLogin.matchOrigin(event.origin) || !qrLogin.matchData(event.data)) return
          const tmpCode = (event.data as { tmp_code?: unknown } | null)?.tmp_code
          if (typeof tmpCode !== 'string' || !tmpCode.trim()) return

          setQrStatus('scanned')
          const redirectUrl = new URL(config.goto)
          redirectUrl.searchParams.set('tmp_code', tmpCode)
          onQrAuthorized(redirectUrl.toString())
        }
        window.addEventListener('message', messageHandler)
        expiryTimer = window.setTimeout(() => {
          document.getElementById('feishu-qr-login')?.replaceChildren()
          setQrStatus('error')
        }, config.expiresIn * 1000)
        setQrStatus('ready')
      } catch (error) {
        if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) {
          setQrStatus('error')
        }
      }
    }

    void initializeQrLogin()

    return () => {
      disposed = true
      abortController.abort()
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      if (messageHandler) window.removeEventListener('message', messageHandler)
    }
  }, [inFeishu, loginQuery, onQrAuthorized, retryKey])

  return (
    <main className="login-page">
      <header className="login-header" aria-label="企业知识助手">
        <span className="login-brand-mark" aria-hidden="true">
          <img src="/quickdone-mark.webp" alt="" />
        </span>
        <span className="login-brand-name">企业知识助手</span>
      </header>

      <section className="login-stage">
        <div className="login-intro">
          <p className="login-eyebrow">QUICKDONE · ENTERPRISE KNOWLEDGE</p>
          <h1>企业知识助手</h1>
          <p className="login-intro-copy">准确回答，从可信来源开始。</p>
          <div className="login-access-note">
            <ShieldCheck size={18} aria-hidden="true" />
            <span>仅向已授权的组织成员开放</span>
          </div>
        </div>

        <div className="login-panel">
          <div className="login-panel-heading">
            <h2>登录</h2>
            {inFeishu ? <p>使用当前飞书账号进入企业知识助手</p> : <>
              <p className="login-desktop-copy">请使用飞书扫描二维码</p>
              <p className="login-mobile-copy">在飞书中确认后即可进入</p>
            </>}
          </div>

          {callbackError ? (
            <div className="login-callback-error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{callbackError}</span>
            </div>
          ) : null}

          {inFeishu ? <div className="login-client-login">
            {clientStatus === 'loading' ? <p role="status"><span className="spinner" /> 正在使用飞书账号登录…</p> : <>
              {clientStatus === 'error' ? <p className="login-callback-error" role="alert">{clientError}</p> : <p>你已退出登录</p>}
              <button type="button" className="login-direct-button" onClick={() => setRetryKey(value => value + 1)}>
                <Smartphone size={18} aria-hidden="true" /> 使用当前飞书账号登录
              </button>
            </>}
          </div> : <>
          <div className="login-desktop-login">
            <div className="login-qr-label">
              <ScanLine size={18} aria-hidden="true" />
              <span>飞书扫码登录</span>
            </div>
            <div className="login-qr-stage">
              <div
                id="feishu-qr-login"
                className="login-qr-container"
                aria-hidden={qrStatus !== 'ready'}
              />
              {qrStatus === 'loading' ? (
                <div className="login-qr-state" role="status" aria-label="正在加载二维码">
                  <span className="login-qr-skeleton" />
                  <span>正在加载二维码</span>
                </div>
              ) : null}
              {qrStatus === 'error' ? (
                <div className="login-qr-state login-qr-error" role="alert">
                  <AlertCircle size={26} aria-hidden="true" />
                  <strong>二维码暂时无法加载</strong>
                  <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
                    <RefreshCw size={16} aria-hidden="true" />
                    重新加载二维码
                  </button>
                </div>
              ) : null}
              {qrStatus === 'scanned' ? (
                <div className="login-qr-state login-qr-scanned" role="status">
                  <span className="spinner" aria-hidden="true" />
                  <strong>已扫码，正在进入</strong>
                </div>
              ) : null}
            </div>
            <p className="login-qr-help">扫码后，请在飞书中确认登录</p>
          </div>

          <div className="login-divider" aria-hidden="true"><span>或</span></div>

          <a className="login-direct-button" href={`/api/auth/feishu/login?${loginQuery}`}>
            <Smartphone size={18} aria-hidden="true" />
            <span>使用飞书登录</span>
            <ArrowRight size={17} aria-hidden="true" />
          </a>

          <p className="login-mobile-tip">电脑端打开本页时，也可使用飞书扫码登录</p>
          </>}
        </div>
      </section>

      <footer className="login-footer">Quickdone</footer>
    </main>
  )
}
