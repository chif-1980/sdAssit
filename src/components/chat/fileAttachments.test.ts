import { describe, expect, it } from 'vitest'

import { attachmentError, attachmentKind, formatAttachmentSize } from './fileAttachments'

function file(name: string, type: string, size = 100) {
  return new File([new Uint8Array(size)], name, { type })
}

describe('chat file attachments', () => {
  it('accepts office, pdf, image, and text files', () => {
    expect(attachmentError(file('方案.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBeUndefined()
    expect(attachmentError(file('报价.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))).toBeUndefined()
    expect(attachmentError(file('说明.pdf', 'application/pdf'))).toBeUndefined()
    expect(attachmentError(file('截图.png', 'image/png'))).toBeUndefined()
  })

  it('rejects audio and video files explicitly', () => {
    expect(attachmentError(file('演示.mp4', 'video/mp4'))).toBe('暂不支持视频或音频文件')
    expect(attachmentError(file('录音.mp3', 'audio/mpeg'))).toBe('暂不支持视频或音频文件')
  })

  it('classifies attachments for compact visual treatment', () => {
    expect(attachmentKind(file('表格.xls', 'application/vnd.ms-excel'))).toBe('spreadsheet')
    expect(attachmentKind(file('图.jpg', 'image/jpeg'))).toBe('image')
    expect(attachmentKind(file('文档.pdf', 'application/pdf'))).toBe('document')
  })

  it('formats file sizes for the composer', () => {
    expect(formatAttachmentSize(800)).toBe('800 B')
    expect(formatAttachmentSize(2048)).toBe('2 KB')
    expect(formatAttachmentSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })
})
