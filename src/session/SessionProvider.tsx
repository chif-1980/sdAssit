import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { User, PlatformSnapshot } from '../../shared/domain/models.js'
import type { UserRole } from '../../shared/domain/enums.js'
import { api } from '../api/client'

type Session = PlatformSnapshot['session']

interface SessionPayload {
  session: Session
  user: User
  users: User[]
}

interface SessionContextValue {
  session?: Session
  user?: User
  users: User[]
  status: 'loading' | 'ready' | 'error'
  error?: Error
  switchRole: (role: UserRole) => Promise<void>
  reload: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined)

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [payload, setPayload] = useState<SessionPayload>()
  const [status, setStatus] = useState<SessionContextValue['status']>('loading')
  const [error, setError] = useState<Error>()

  const reload = useCallback(async () => {
    setStatus('loading')
    setError(undefined)
    try {
      setPayload(await api<SessionPayload>('/api/session'))
      setStatus('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('UNKNOWN_ERROR'))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const switchRole = useCallback(async (role: UserRole) => {
    const next = await api<SessionPayload>('/api/session/role', {
      method: 'PUT',
      body: JSON.stringify({ role }),
    })
    setPayload(next)
    setStatus('ready')
  }, [])

  const value = useMemo<SessionContextValue>(() => ({
    session: payload?.session,
    user: payload?.user,
    users: payload?.users ?? [],
    status,
    error,
    switchRole,
    reload,
  }), [error, payload, reload, status, switchRole])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const context = useContext(SessionContext)
  if (!context) throw new Error('SESSION_PROVIDER_REQUIRED')
  return context
}
