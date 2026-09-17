export type MaterialShareChannel = 'WECHAT' | 'FEISHU' | 'DINGTALK'

export type MaterialShareResult = 'SHARED' | 'CANCELLED' | 'FALLBACK'
export type ShareApplicationOpenResult = 'OPENED' | 'UNSUPPORTED'

export interface ShareableMaterial {
  title: string
  fileName: string
  size: string
  summary: string
  sourcePath?: string | null
  shareText?: string
}

export interface MaterialShareApi {
  share?: (data: ShareData) => Promise<void>
  canShare?: (data?: ShareData) => boolean
}

export type ShareApplicationOpener = (url: string, target?: string) => Window | null

const channelLabels: Record<MaterialShareChannel, string> = {
  WECHAT: '微信',
  FEISHU: '飞书',
  DINGTALK: '钉钉',
}

function shareFileName(fileName: string) {
  return fileName.replace(/\.(?:pdf|pptx|docx|xlsx)$/iu, '.txt')
}

export function materialShareText(material: ShareableMaterial) {
  return material.shareText ?? `${material.title}\n\n${material.summary}\n\n来源：${material.sourcePath ?? '飞书知识库'}`
}

export function materialShareFile(material: ShareableMaterial) {
  return new File([materialShareText(material)], shareFileName(material.fileName), { type: 'text/plain' })
}

function browserShareApi(): MaterialShareApi {
  if (typeof navigator === 'undefined') return {}
  return navigator as MaterialShareApi
}

/**
 * Check whether this device is likely to accept a file in the native share
 * sheet. This synchronous probe lets callers launch a custom app protocol from
 * the original button click when a desktop fallback is already apparent.
 */
export function canShareMaterialFiles(
  shareApi: MaterialShareApi = browserShareApi(),
  mimeType = 'text/plain',
) {
  if (typeof shareApi.share !== 'function') return false
  if (typeof shareApi.canShare !== 'function') return true
  if (typeof File !== 'function') return false
  try {
    return shareApi.canShare({ files: [new File(['share-check'], 'share-check', { type: mimeType })] })
  } catch {
    return false
  }
}

/**
 * Best-effort hand-off to an installed desktop application. Browsers do not
 * expose an API for selecting a contact or attaching a file to a chat, so the
 * client still needs the user to choose the recipient and file. The custom
 * protocol only starts the app when the browser/device allows it.
 */
export function openShareApplication(
  channel: MaterialShareChannel,
  opener: ShareApplicationOpener = (url, target = '_self') => {
    if (typeof window === 'undefined' || typeof window.open !== 'function') return null
    return window.open(url, target)
  },
): ShareApplicationOpenResult {
  const protocol = channel === 'WECHAT' ? 'weixin://' : null
  if (!protocol) return 'UNSUPPORTED'
  try {
    return opener(protocol, '_self') ? 'OPENED' : 'UNSUPPORTED'
  } catch {
    return 'UNSUPPORTED'
  }
}

/**
 * Prefer the device share sheet. When the browser or channel cannot accept a
 * file, callers can download the file and let the user choose the app from
 * the system share sheet instead.
 */
export async function shareMaterialViaDevice(
  material: ShareableMaterial,
  channel: MaterialShareChannel,
  shareApi: MaterialShareApi = browserShareApi(),
  downloadedFile?: File,
): Promise<MaterialShareResult> {
  if (channel === 'DINGTALK' || typeof shareApi.share !== 'function') return 'FALLBACK'

  const file = downloadedFile ?? materialShareFile(material)
  const data: ShareData = {
    title: `${channelLabels[channel]} · ${material.title}`,
    text: materialShareText(material),
    files: [file],
  }
  if (typeof shareApi.canShare === 'function') {
    try {
      if (!shareApi.canShare(data)) return 'FALLBACK'
    } catch {
      // Some browsers throw for unsupported file types instead of returning
      // false. Treat that the same as an unavailable native share sheet.
      return 'FALLBACK'
    }
  }

  try {
    await shareApi.share(data)
    return 'SHARED'
  } catch (error) {
    // The browser uses AbortError when the user closes the share sheet. That
    // is a completed interaction, not a system failure.
    if (error instanceof DOMException && error.name === 'AbortError') return 'CANCELLED'
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return 'CANCELLED'
    return 'FALLBACK'
  }
}
