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

it('retains only the numeric native failure code and allows a fresh attempt', async () => {
  window.h5sdk = { ready: callback => callback() }
  window.tt = { requestAccess: options => options.fail({ errno: 2700002, errString: 'private diagnostic', code: 'secret' }) }
  const { requestFeishuCode, feishuClientErrorMessage } = await import('./feishuClient')
  const error = await requestFeishuCode('app', 'state').catch(error => error)
  expect(error.errno).toBe(2700002)
  expect(feishuClientErrorMessage(error)).toContain('2700002')
  expect(feishuClientErrorMessage(error)).not.toMatch(/private|secret|更新飞书/)
  expect(JSON.stringify(error)).not.toMatch(/private|secret/)
  window.tt.requestAccess = options => options.success({ code: 'retry-code', state: options.state })
  await expect(requestFeishuCode('app', 'new-state')).resolves.toBe('retry-code')
})

it('catches bridge exceptions after asynchronous readiness and clears the timeout', async () => {
  let ready!: () => void
  window.h5sdk = { ready: callback => { ready = callback } }
  window.tt = { requestAccess: () => { throw { errno: 103 } } }
  const { requestFeishuCode, feishuClientErrorMessage } = await import('./feishuClient')
  const result = requestFeishuCode('app', 'state')
  const rejected = expect(result).rejects.toMatchObject({ errno: 103 })
  await vi.advanceTimersByTimeAsync(1)
  expect(() => ready()).not.toThrow()
  await rejected
  expect(vi.getTimerCount()).toBe(0)
  expect(feishuClientErrorMessage(await result.catch(error => error))).toContain('更新飞书')
})

it.each([{ code: '' }, { code: 'secret-code', state: 'wrong-state' }])('rejects an invalid authorization response', async result => {
  window.h5sdk = { ready: callback => callback() }
  window.tt = { requestAccess: options => options.success(result) }
  const { requestFeishuCode } = await import('./feishuClient')
  await expect(requestFeishuCode('app', 'state')).rejects.toThrow('CLIENT_LOGIN_FAILED')
})
