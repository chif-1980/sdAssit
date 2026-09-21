const SDK_URL = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.26.js'

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
    script.onload = () => finish()
    script.onerror = () => finish(new Error('SDK_UNAVAILABLE'))
    document.head.append(script)
  }).catch(error => { sdkPromise = undefined; throw error })
  return sdkPromise
}

export async function requestFeishuCode(appId: string, state: string): Promise<string> {
  await loadSdk()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('CLIENT_LOGIN_TIMEOUT')), 60000)
    const fail = () => { window.clearTimeout(timer); reject(new Error('CLIENT_LOGIN_FAILED')) }
    if (!window.h5sdk || !window.tt?.requestAccess) { fail(); return }
    window.h5sdk.ready(() => {
      window.tt!.requestAccess!({
        appID: appId, scopeList: [], state,
        success(result) {
          window.clearTimeout(timer)
          if (!result.code || (result.state && result.state !== state)) { fail(); return }
          resolve(result.code)
        },
        fail,
      })
    })
  })
}
