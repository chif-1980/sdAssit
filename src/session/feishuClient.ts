const SDK_URL = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.26.js'

export class FeishuClientLoginError extends Error {
  constructor(message: string, readonly errno?: number) {
    super(message)
    this.name = 'FeishuClientLoginError'
  }
}

export function feishuClientErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === 'SDK_TIMEOUT' || error.message === 'SDK_UNAVAILABLE') {
      return '飞书登录组件未能加载，请检查网络后重试'
    }
    if (error.message === 'CLIENT_LOGIN_TIMEOUT') return '飞书登录响应超时，请关闭应用后重新打开'
    if (error instanceof FeishuClientLoginError) {
      if (error.errno === 103) return '当前飞书客户端不支持此登录方式，请更新飞书后重试（错误码：103）'
      if (error.errno === 2700002) return '飞书授权未完成，请重试；如已同意授权，请联系管理员检查登录配置（错误码：2700002）'
      const suffix = error.errno === undefined ? '' : `（错误码：${error.errno}）`
      return `未能获取飞书登录授权，请重试或联系管理员检查登录配置${suffix}`
    }
  }
  return '暂时无法完成飞书登录，请重试或联系管理员'
}

function nativeLoginError(error: unknown): FeishuClientLoginError {
  // Only retain numeric diagnostic codes, never raw SDK payloads or credentials.
  const value = error && typeof error === 'object' && 'errno' in error ? error.errno : undefined
  const errno = typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
  return new FeishuClientLoginError('CLIENT_LOGIN_FAILED', errno)
}

declare global {
  interface Window {
    h5sdk?: { ready(callback: () => void): void }
    tt?: {
      requestAccess?: (options: {
        appID: string
        scopeList: string[]
        state: string
        success(result: { code: string; state?: string }): void
        fail(error: unknown): void
      }) => void
    }
  }
}

export function isFeishuClient(): boolean {
  return /(?:Lark|Feishu)\//i.test(navigator.userAgent)
}

let sdkPromise: Promise<void> | undefined
function loadSdk(): Promise<void> {
  if (window.h5sdk && window.tt?.requestAccess) return Promise.resolve()
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    const timer = window.setTimeout(() => finish(new Error('SDK_TIMEOUT')), 15000)
    const finish = (error?: Error) => {
      window.clearTimeout(timer)
      script.onload = null
      script.onerror = null
      if (error) { script.remove(); reject(error) } else resolve()
    }
    script.src = SDK_URL
    script.async = true
    script.dataset.feishuClientSdk = 'true'
    script.onload = () => finish(window.h5sdk && window.tt?.requestAccess ? undefined : new Error('SDK_UNAVAILABLE'))
    script.onerror = () => finish(new Error('SDK_UNAVAILABLE'))
    document.head.append(script)
  }).catch(error => { sdkPromise = undefined; throw error })
  return sdkPromise
}

export async function requestFeishuCode(appId: string, state: string): Promise<string> {
  await loadSdk()
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('CLIENT_LOGIN_TIMEOUT'))
    }, 60000)
    const fail = (error?: unknown) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      reject(nativeLoginError(error))
    }
    if (!window.h5sdk || !window.tt?.requestAccess) { fail(); return }
    const request = () => {
      if (settled) return
      try {
        window.tt!.requestAccess!({
          appID: appId, scopeList: [], state,
          success(result) {
            if (settled) return
            window.clearTimeout(timer)
            if (!result.code || (result.state && result.state !== state)) { fail(); return }
            settled = true
            resolve(result.code)
          },
          fail,
        })
      } catch (error) { fail(error) }
    }
    try { window.h5sdk.ready(request) } catch (error) { fail(error) }
  })
}
