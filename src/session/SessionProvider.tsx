import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

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
  const requestGenerationRef = useRef(0)
  const mountedRef = useRef(false)

  const reload = useCallback(async () => {
    const generation = ++requestGenerationRef.current
    if (!mountedRef.current) return
    setStatus('loading')
    setError(undefined)
    try {
      const payload = await api<SessionPayload>('/api/session')
      if (!mountedRef.current || requestGenerationRef.current !== generation) return
      setUser(payload.user)
      setStatus('authenticated')
    } catch (cause) {
      if (!mountedRef.current || requestGenerationRef.current !== generation) return
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
    mountedRef.current = true
    void reload()
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
    }
  }, [reload])

  const logout = useCallback(async () => {
    requestGenerationRef.current += 1
    await api('/api/auth/logout', { method: 'POST' })
    requestGenerationRef.current += 1
    if (!mountedRef.current) return
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
