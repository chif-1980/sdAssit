import { describe, expect, it, vi } from 'vitest'

import { canShareMaterialFiles, materialShareFile, openShareApplication, shareMaterialViaDevice, type ShareableMaterial } from './materialSharing'

const material: ShareableMaterial = {
  title: '产品说明 v3.2',
  fileName: '产品说明-v3.2.pdf',
  size: '2.4 MB',
  summary: '覆盖产品定位和部署方式。',
  sourcePath: '飞书知识库 / 产品资料',
}

describe('material sharing', () => {
  it('opens the mobile share sheet with a file for Feishu or WeChat', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(async () => undefined)
    const result = await shareMaterialViaDevice(material, 'FEISHU', { share, canShare: () => true })

    expect(result).toBe('SHARED')
    expect(share).toHaveBeenCalledTimes(1)
    const sharePayload = share.mock.calls[0]?.[0]
    expect(sharePayload).toMatchObject({
      title: '飞书 · 产品说明 v3.2',
      text: expect.stringContaining('飞书知识库 / 产品资料'),
    })
    expect(sharePayload?.files?.[0]).toBeInstanceOf(File)
  })

  it('falls back when file sharing is not available', async () => {
    const result = await shareMaterialViaDevice(material, 'WECHAT', { share: vi.fn(), canShare: () => false })
    expect(result).toBe('FALLBACK')
  })

  it('treats closing the native sheet as cancellation', async () => {
    const result = await shareMaterialViaDevice(material, 'WECHAT', {
      share: vi.fn(async () => { throw new DOMException('dismissed', 'AbortError') }),
    })
    expect(result).toBe('CANCELLED')
  })

  it('falls back when the native share call is rejected by the browser', async () => {
    const result = await shareMaterialViaDevice(material, 'WECHAT', {
      share: vi.fn(async () => { throw new Error('NotAllowedError') }),
    })

    expect(result).toBe('FALLBACK')
  })

  it('creates a safe text fallback file without changing the source title', () => {
    const file = materialShareFile(material)
    expect(file.name).toBe('产品说明-v3.2.txt')
    expect(file.type).toBe('text/plain')
  })

  it('opens the WeChat client protocol when the browser allows it', () => {
    const opener = vi.fn(() => ({ closed: false }) as unknown as Window)

    expect(openShareApplication('WECHAT', opener)).toBe('OPENED')
    expect(opener).toHaveBeenCalledWith('weixin://', '_self')
  })

  it('detects when the native file share sheet is unavailable', () => {
    expect(canShareMaterialFiles({})).toBe(false)
    expect(canShareMaterialFiles({ share: vi.fn(async () => undefined), canShare: () => false })).toBe(false)
    expect(canShareMaterialFiles({ share: vi.fn(async () => undefined), canShare: () => true }, 'application/pdf')).toBe(true)
  })

  it('reports an unavailable client protocol without throwing', () => {
    const opener = vi.fn(() => null)

    expect(openShareApplication('WECHAT', opener)).toBe('UNSUPPORTED')
    expect(openShareApplication('FEISHU', opener)).toBe('UNSUPPORTED')
    expect(opener).toHaveBeenCalledTimes(1)
  })
})
