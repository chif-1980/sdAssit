import type { AssetSection } from '../../shared/domain/models.js'
import type { KnowledgeType } from '../../shared/domain/enums.js'

export interface ExtractedCandidate {
  title: string
  content: string
  knowledgeType: KnowledgeType
  sourceLocator: string
  sourceExcerpt: string
}

const candidateWords = ['支持', '必须', '不得', '最低']

/**
 * Small, deterministic replacement for an extraction model. It deliberately
 * only emits atomic statements with an explicit product/policy signal so the
 * review queue remains explainable in local development and tests.
 */
export class DeterministicAi {
  extract(sections: AssetSection[]): ExtractedCandidate[] {
    const candidates: ExtractedCandidate[] = []
    for (const section of sections) {
      if (!candidateWords.some((word) => section.excerpt.includes(word))) continue

      candidates.push({
        title: section.excerpt.slice(0, 32),
        content: section.excerpt,
        knowledgeType: this.knowledgeTypeFor(section.excerpt),
        sourceLocator: section.locator,
        sourceExcerpt: section.excerpt,
      })
    }
    return candidates
  }

  private knowledgeTypeFor(content: string): KnowledgeType {
    if (/(必须|不得|最低|禁止|规范|策略|政策)/u.test(content)) return 'POLICY'
    if (/(流程|步骤|操作|审批)/u.test(content)) return 'PROCESS'
    if (/(参数|配置|规格|容量|延迟|版本)/u.test(content)) return 'PRODUCT_PARAMETER'
    if (/(部署|接口|API|SDK|技术|架构)/iu.test(content)) return 'TECHNICAL'
    if (/(如何|怎么|为什么|问答|FAQ)/iu.test(content)) return 'FAQ'
    return 'PRODUCT_CAPABILITY'
  }
}

/** Split text on paragraphs and sentence-ending punctuation while retaining
 * punctuation in the evidence excerpt. */
export function parseTextSections(content: string): AssetSection[] {
  const sections: AssetSection[] = []
  const paragraphs = content.replace(/\r\n?/gu, '\n').split(/\n\s*\n+/u)
  let sectionIndex = 0

  for (const paragraph of paragraphs) {
    const sentences = paragraph.trim().split(/(?<=[。！？!?；;.])\s*/u)
    for (const sentence of sentences) {
      const excerpt = sentence.trim()
      if (!excerpt) continue
      sectionIndex += 1
      sections.push({
        id: `SEC-${sectionIndex}`,
        title: excerpt.slice(0, 32),
        locator: `paragraph:${sectionIndex}`,
        excerpt,
      })
    }
  }

  return sections
}

export function summarizeSections(sections: AssetSection[]) {
  return sections.map((section) => section.excerpt).join(' ').slice(0, 240)
}
