export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

const supportedExtensions = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'markdown', 'csv',
  'png', 'jpg', 'jpeg', 'webp',
])

const supportedMimeTypes = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/webp',
])

function extensionOf(name: string) {
  return name.split('.').at(-1)?.toLocaleLowerCase() ?? ''
}

export function attachmentError(file: File) {
  const extension = extensionOf(file.name)
  const mime = file.type.split(';', 1)[0].trim().toLocaleLowerCase()
  if (mime.startsWith('video/') || mime.startsWith('audio/') || ['mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'aac'].includes(extension)) {
    return '暂不支持视频或音频文件'
  }
  if (file.size > MAX_ATTACHMENT_SIZE) return '单个文件不能超过 100 MB'
  if (!supportedExtensions.has(extension) && !supportedMimeTypes.has(mime)) {
    return '暂不支持此文件格式'
  }
  return undefined
}

export function attachmentKind(file: File) {
  const extension = extensionOf(file.name)
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension) || file.type.startsWith('image/')) return 'image' as const
  if (['xls', 'xlsx', 'csv'].includes(extension) || file.type.includes('spreadsheet') || file.type === 'text/csv') return 'spreadsheet' as const
  return 'document' as const
}

export function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
