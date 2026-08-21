import { createHash } from 'node:crypto'

import type {
  ApplicabilityScope,
  Asset,
  Candidate,
  CrossDocumentRelation,
  PlatformSnapshot,
} from '../../shared/domain/models.js'
import type { CrossDocumentRelationType } from '../../shared/domain/enums.js'
import { createBusinessId } from '../../shared/domain/ids.js'
import { normalizeKnowledgeText } from '../adapters/localRetrieval.js'

const scopeLabels: Array<[keyof ApplicabilityScope, string]> = [
  ['industry', '行业'],
  ['product', '产品'],
  ['productVersion', '产品版本'],
  ['deploymentMode', '部署模式'],
  ['customerType', '客户类型'],
  ['locale', '地区/语言'],
]

function tokenize(value: string) {
  return new Set(value.normalize('NFKC').toLocaleLowerCase().match(/[\p{Script=Han}]|[a-z0-9]+/giu) ?? [])
}

function similarity(left: string, right: string) {
  const a = tokenize(left)
  const b = tokenize(right)
  if (!a.size || !b.size) return 0
  let overlap = 0
  for (const token of a) if (b.has(token)) overlap += 1
  return overlap / new Set([...a, ...b]).size
}

function hasConflictSignal(left: string, right: string) {
  const leftNumbers = left.match(/(?:\d+(?:\.\d+)?|≥|≤|>=|<=|>|<|必须|不得|可以|禁止)/gu) ?? []
  const rightNumbers = right.match(/(?:\d+(?:\.\d+)?|≥|≤|>=|<=|>|<|必须|不得|可以|禁止)/gu) ?? []
  const leftNegation = /不得|禁止|不能|不支持/iu.test(left)
  const rightNegation = /不得|禁止|不能|不支持/iu.test(right)
  return leftNegation !== rightNegation || leftNumbers.join('|') !== rightNumbers.join('|')
}

export function deriveApplicability(value: string, title = ''): ApplicabilityScope {
  const text = `${title} ${value}`
  const scope: ApplicabilityScope = {}
  const industry = text.match(/制造业|金融|医疗|教育|零售|能源|政务|通用/iu)?.[0]
  const product = text.match(/\bQ\d{2,4}\b/iu)?.[0]
  const productVersion = text.match(/(?:版本|v)\s*\d+(?:\.\d+){1,3}/iu)?.[0]
  const deploymentMode = text.match(/标准部署|轻量部署|私有化部署|公有云|SaaS|混合部署/iu)?.[0]
  const customerType = text.match(/大客户|中小企业|政府客户|客户/iu)?.[0]
  if (industry) scope.industry = industry
  if (product) scope.product = product.toUpperCase()
  if (productVersion) scope.productVersion = productVersion.replace(/^版本\s*/iu, 'v')
  if (deploymentMode) scope.deploymentMode = deploymentMode
  if (customerType) scope.customerType = customerType
  scope.locale = 'zh-CN'
  return scope
}

function scopeDiffs(left: ApplicabilityScope | undefined, right: ApplicabilityScope | undefined) {
  const diffs: string[] = []
  for (const [key, label] of scopeLabels) {
    const a = left?.[key]
    const b = right?.[key]
    if (a && b && a !== b) diffs.push(`${label}：${a} / ${b}`)
  }
  return diffs
}

function scopeDisjoint(left: ApplicabilityScope | undefined, right: ApplicabilityScope | undefined) {
  return scopeLabels.some(([key]) => Boolean(left?.[key] && right?.[key] && left?.[key] !== right?.[key]))
}

function classify(left: string, right: string, leftScope?: ApplicabilityScope, rightScope?: ApplicabilityScope) {
  const normalizedLeft = normalizeKnowledgeText(left)
  const normalizedRight = normalizeKnowledgeText(right)
  const exact = normalizedLeft === normalizedRight
  const score = exact ? 1 : similarity(left, right)
  const scopeDifferent = scopeDisjoint(leftScope, rightScope)
  let relationType: CrossDocumentRelationType
  if (exact && scopeDifferent) relationType = 'CONDITIONAL_VARIANT'
  else if (exact) relationType = 'EXACT_DUPLICATE'
  else if (score >= 0.56 && !scopeDifferent && hasConflictSignal(left, right)) relationType = 'CONFLICT'
  else if (score >= 0.56) relationType = 'OVERLAP'
  else if (score >= 0.28) relationType = scopeDifferent ? 'CONDITIONAL_VARIANT' : 'COMPLEMENTARY'
  else relationType = 'INSUFFICIENT'
  return { relationType, score, confidence: exact ? 0.99 : Math.min(0.95, Math.max(0.55, score + 0.18)) }
}

function relationKey(leftAssetId: string, rightAssetId: string, leftLocator: string, rightLocator: string, leftExcerpt: string, rightExcerpt: string) {
  const ordered = leftAssetId < rightAssetId
    ? [leftAssetId, rightAssetId, leftLocator, rightLocator, leftExcerpt, rightExcerpt]
    : [rightAssetId, leftAssetId, rightLocator, leftLocator, rightExcerpt, leftExcerpt]
  return createHash('sha256').update(ordered.join('\u0000'), 'utf8').digest('hex')
}

function existingRelation(snapshot: PlatformSnapshot, key: string) {
  return (snapshot.crossDocumentRelations ?? []).find((relation) => relation.relationKey === key)
}

export interface CompareInput {
  asset: Asset
  candidate: Candidate
  candidateScope?: ApplicabilityScope
}

export function compareCandidateAcrossDocuments(snapshot: PlatformSnapshot, input: CompareInput) {
  const relations: CrossDocumentRelation[] = []
  const candidateScope = input.candidateScope ?? input.candidate.applicability
  for (const asset of snapshot.assets) {
    if (asset.id === input.asset.id || asset.isSessionAsset || asset.processStatus !== 'PROCESSED') continue
    for (const section of asset.sections) {
      const comparison = classify(input.candidate.content, section.excerpt, candidateScope, deriveApplicability(section.excerpt, asset.title))
      if (comparison.relationType === 'INSUFFICIENT') continue
      const key = relationKey(input.asset.id, asset.id, input.candidate.sourceLocator, section.locator, input.candidate.sourceExcerpt, section.excerpt)
      const existing = existingRelation(snapshot, key)
      relations.push(existing ?? {
        id: createBusinessId('relation'),
        relationKey: key,
        relationType: comparison.relationType,
        leftAssetId: input.asset.id,
        rightAssetId: asset.id,
        leftCandidateId: input.candidate.id,
        leftLocator: input.candidate.sourceLocator,
        rightLocator: section.locator,
        leftExcerpt: input.candidate.sourceExcerpt,
        rightExcerpt: section.excerpt,
        similarity: comparison.score,
        confidence: comparison.confidence,
        scopeDiffs: scopeDiffs(candidateScope, deriveApplicability(section.excerpt, asset.title)),
        sharedContent: comparison.relationType === 'EXACT_DUPLICATE' ? input.candidate.content : undefined,
        diffContent: comparison.relationType === 'CONFLICT' || comparison.relationType === 'OVERLAP'
          ? `${input.candidate.content}\n↕\n${section.excerpt}` : undefined,
        aiReason: `跨文档比较：${comparison.relationType}`,
        status: comparison.relationType === 'EXACT_DUPLICATE' || comparison.relationType === 'CONDITIONAL_VARIANT'
          ? 'AUTO_RESOLVED' : 'PENDING',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }
  }
  return relations
}

export function comparisonForReview(snapshot: PlatformSnapshot, review: { comparisonRelationIds?: string[]; candidateId?: string }) {
  const relationIds = new Set(review.comparisonRelationIds ?? [])
  return (snapshot.crossDocumentRelations ?? []).filter((relation) => relationIds.has(relation.id)
    || (review.candidateId !== undefined && relation.leftCandidateId === review.candidateId))
}
