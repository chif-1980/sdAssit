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
import { api } from '../api/client'

const QR_SDK_URL = 'https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js'
const DIRECT_LOGIN_URL = '/api/auth/feishu/login?return_path=%2Fchat'
const QR_CONFIG_URL = '/api/auth/feishu/qr-config?return_path=%2Fchat'

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

export function LoginPage({ onQrAuthorized = defaultQrAuthorized }: LoginPageProps) {
  const [qrStatus, setQrStatus] = useState<QrLoginStatus>('loading')
  const [retryKey, setRetryKey] = useState(0)
  const callbackError = useMemo(() => {
    const errorCode = new URLSearchParams(window.location.search).get('error')
    return errorCode ? loginErrorMessages[errorCode] ?? '登录未完成，请重新尝试' : null
  }, [])

  useEffect(() => {
    const abortController = new AbortController()
    let disposed = false
    let expiryTimer: number | undefined
    let messageHandler: ((event: MessageEvent) => void) | undefined

    setQrStatus('loading')
    document.getElementById('feishu-qr-login')?.replaceChildren()

    const initializeQrLogin = async () => {
      try {
        const [config, qrLoginFactory] = await Promise.all([
          api<FeishuQrLoginConfig>(QR_CONFIG_URL, {
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
  }, [onQrAuthorized, retryKey])

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
            <p className="login-desktop-copy">请使用飞书扫描二维码</p>
            <p className="login-mobile-copy">在飞书中确认后即可进入</p>
          </div>

          {callbackError ? (
            <div className="login-callback-error" role="alert">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{callbackError}</span>
            </div>
          ) : null}

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

          <a className="login-direct-button" href={DIRECT_LOGIN_URL}>
            <Smartphone size={18} aria-hidden="true" />
            <span>使用飞书登录</span>
            <ArrowRight size={17} aria-hidden="true" />
          </a>

          <p className="login-mobile-tip">电脑端打开本页时，也可使用飞书扫码登录</p>
        </div>
      </section>

      <footer className="login-footer">Quickdone</footer>
    </main>
  )
}
