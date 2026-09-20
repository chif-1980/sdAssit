import type { ProductMessage } from '../../../shared/api/product.js'

export interface MessagePair {
  id: string
  user?: ProductMessage
  assistant?: ProductMessage
}

/** Groups the persisted message stream into the question/answer units used by navigation. */
export function groupMessagePairs(messages: ProductMessage[]): MessagePair[] {
  const pairs: MessagePair[] = []
  let pendingUser: ProductMessage | undefined

  for (const message of messages) {
    if (message.role === 'USER') {
      if (pendingUser) pairs.push({ id: pendingUser.id, user: pendingUser })
      pendingUser = message
      continue
    }

    if (pendingUser) {
      pairs.push({ id: pendingUser.id, user: pendingUser, assistant: message })
      pendingUser = undefined
    } else {
      pairs.push({ id: message.id, assistant: message })
    }
  }

  if (pendingUser) pairs.push({ id: pendingUser.id, user: pendingUser })
  return pairs
}

export function messagePairAnchorId(pairId: string) {
  return `message-pair-${pairId}`
}

export function truncatePreview(value: string | undefined, length: number) {
  // Preview text has no Markdown renderer; strip presentation syntax before
  // truncation so the cutoff cannot leave half of a bold marker or link.
  const normalized = (value ?? '')
    .replace(/^\s*(`{3,}|~{3,}).*$/gmu, '')
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/gu, '$1')
    .replace(/\[(?:\d+|S\d+-P\d+|H\d+)\]/gu, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/\*\*|__|~~|`/gu, '')
    .replace(/\*([^*\n]+)\*/gu, '$1')
    .replace(/\s+/gu, ' ').trim()
  if (normalized.length <= length) return normalized
  return `${normalized.slice(0, Math.max(1, length - 1))}…`
}
