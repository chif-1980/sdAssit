export type { ProductMaterial } from './product.js'
import type { ProductCitation } from './product.js'

export type MaterialShareChannel = 'WECHAT' | 'FEISHU' | 'DINGTALK'
export type MaterialDistributionMode = 'DEVICE_SHARE'
export type MaterialDistributionStatus = 'READY' | 'DISPATCHED' | 'FAILED' | 'CANCELLED'

/**
 * A distribution task never contains a public link or a copied file. The
 * client uses the returned download URL with the device share sheet, subject
 * to the current user's Feishu permissions.
 */
export interface MaterialDistributionTask {
  id: string
  materialId: string
  requesterId: string
  channel: MaterialShareChannel
  mode: MaterialDistributionMode
  status: MaterialDistributionStatus
  createdAt: string
  completedAt?: string
}

export interface MaterialDistributionResponse {
  distribution: MaterialDistributionTask
  title: string
  text: string
  downloadUrl: string
  requiresUserConfirmation: true
}

export interface MaterialSearchResponse {
  materials: import('./product.js').ProductMaterial[]
}
