import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
})

afterEach(() => {
  vi.useRealTimers()
  delete window.h5sdk
  delete window.tt
  document.querySelectorAll('script[data-feishu-client-sdk]').forEach(script => script.remove())
})

it('does not request authorization if SDK ready arrives after login timed out', async () => {
  let ready!: () => void
  const requestAccess = vi.fn()
  window.h5sdk = { ready: callback => { ready = callback } }
  window.tt = { requestAccess }
  const { requestFeishuCode } = await import('./feishuClient')
  const result = requestFeishuCode('app', 'state')
  const rejected = expect(result).rejects.toThrow('CLIENT_LOGIN_TIMEOUT')
  await vi.advanceTimersByTimeAsync(60000)
  await rejected
  ready()
  expect(requestAccess).not.toHaveBeenCalled()
})

it('retries loading when a script completes without a usable SDK', async () => {
  const { requestFeishuCode } = await import('./feishuClient')
  const failed = requestFeishuCode('app', 'state')
  const rejected = expect(failed).rejects.toThrow('SDK_UNAVAILABLE')
  document.querySelector('script[data-feishu-client-sdk]')!.dispatchEvent(new Event('load'))
  await rejected
  const result = requestFeishuCode('app', 'state')
  window.h5sdk = { ready: callback => callback() }
  window.tt = { requestAccess: options => options.success({ code: 'one-time-code', state: options.state }) }
  document.querySelector('script[data-feishu-client-sdk]')!.dispatchEvent(new Event('load'))
  await expect(result).resolves.toBe('one-time-code')
})
