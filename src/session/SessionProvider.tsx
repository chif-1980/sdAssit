import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { ProductUser } from '../../shared/api/product.js'
import { api, ApiError } from '../api/client'

interface SessionPayload {
  user: ProductUser
}

interface SessionContextValue {
  user?: ProductUser
  status: 'loading' | 'authenticated' | 'anonymous' | 'error'
  error?: Error
  reload: () => Promise<void>
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<ProductUser>()
  const [status, setStatus] = useState<SessionContextValue['status']>('loading')
  const [error, setError] = useState<Error>()

  const reload = useCallback(async () => {
    setStatus('loading')
    setError(undefined)
    try {
      const payload = await api<SessionPayload>('/api/session')
      setUser(payload.user)
      setStatus('authenticated')
    } catch (cause) {
      setUser(undefined)
      if (cause instanceof ApiError && cause.status === 401) {
        setStatus('anonymous')
        return
      }
      setError(cause instanceof Error ? cause : new Error('UNKNOWN_ERROR'))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' })
    setUser(undefined)
    setError(undefined)
    setStatus('anonymous')
  }, [])

  const value = useMemo<SessionContextValue>(() => ({
    user,
    status,
    error,
    reload,
    logout,
  }), [error, logout, reload, status, user])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const context = useContext(SessionContext)
  if (!context) throw new Error('SESSION_PROVIDER_REQUIRED')
  return context
}
