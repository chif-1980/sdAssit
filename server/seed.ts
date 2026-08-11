import type { PlatformSnapshot } from '../shared/domain/models.js'

export function seedSnapshot(): PlatformSnapshot {
  return {
    version: 1,
    session: { userId: 'USR-EMPLOYEE', role: 'EMPLOYEE' },
    users: [
      { id: 'USR-EMPLOYEE', name: '演示员工', role: 'EMPLOYEE' },
      { id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' },
      { id: 'USR-ADMIN', name: '系统管理员', role: 'ADMIN' },
    ],
    assets: [],
    candidates: [],
    knowledge: [],
    reviews: [],
    conversations: [],
    messages: [],
    assetInputs: {},
  }
}
