import { ulid } from 'ulid'

const prefixes = {
  asset: 'AST',
  candidate: 'KCD',
  knowledge: 'KNW',
  review: 'RVW',
  relation: 'REL',
  conversation: 'CVS',
} as const

export type IdKind = keyof typeof prefixes

export function createBusinessId(kind: IdKind) {
  return `${prefixes[kind]}-${ulid()}`
}
