import type { AuditLog, AuditOutcome, PlatformSnapshot } from '../../shared/domain/models.js'
import { createBusinessId } from '../../shared/domain/ids.js'
import type { PlatformRepository } from './ports.js'

export interface AuditLogInput {
  actorId?: string
  actorRole?: AuditLog['actorRole']
  action: string
  resourceType: string
  resourceId?: string
  outcome?: AuditOutcome
  metadata?: Record<string, string | number | boolean | null | undefined>
}

const sensitiveKey = /(token|secret|password|authorization|cookie|credential|content|body|prompt|text)/iu

function now() {
  return new Date().toISOString()
}

function safeMetadata(metadata: AuditLogInput['metadata']) {
  if (!metadata) return undefined
  const entries = Object.entries(metadata)
    .filter(([key, value]) => !sensitiveKey.test(key) && value !== undefined)
    .slice(0, 20)
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 300) : value] as const)
  return entries.length
    ? Object.fromEntries(entries) as Record<string, string | number | boolean | null>
    : undefined
}

export function appendAuditLogToDraft(draft: PlatformSnapshot, input: AuditLogInput): AuditLog {
  const actorId = input.actorId ?? draft.session.userId
  const actor = draft.users.find((user) => user.id === actorId)
  const actorRole = input.actorRole ?? actor?.role ?? draft.session.role
  const log: AuditLog = {
    id: createBusinessId('audit'),
    actorId,
    actorRole,
    action: input.action,
    resourceType: input.resourceType,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    outcome: input.outcome ?? 'SUCCESS',
    ...(safeMetadata(input.metadata) ? { metadata: safeMetadata(input.metadata) } : {}),
    createdAt: now(),
  }
  if (!draft.auditLogs) draft.auditLogs = []
  draft.auditLogs.push(log)
  return log
}

export async function appendAuditLog(repository: PlatformRepository, input: AuditLogInput) {
  return repository.transact((draft) => appendAuditLogToDraft(draft, input))
}

export interface AuditLogQuery {
  action?: string
  resourceType?: string
  resourceId?: string
  outcome?: AuditOutcome
  from?: string
  to?: string
  limit?: number
}

export function listAuditLogs(snapshot: PlatformSnapshot, query: AuditLogQuery = {}) {
  if (snapshot.session.role !== 'ADMIN') throw new Error('FORBIDDEN')
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
  return [...(snapshot.auditLogs ?? [])]
    .filter((log) => !query.action || log.action === query.action)
    .filter((log) => !query.resourceType || log.resourceType === query.resourceType)
    .filter((log) => !query.resourceId || log.resourceId === query.resourceId)
    .filter((log) => !query.outcome || log.outcome === query.outcome)
    .filter((log) => !query.from || log.createdAt >= query.from)
    .filter((log) => !query.to || log.createdAt <= query.to)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, limit)
}
