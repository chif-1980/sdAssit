import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KnowledgeListPage } from './KnowledgeListPage'

vi.mock('../session/SessionProvider', () => ({
  useSession: () => ({ users: [{ id: 'USR-OWNER', name: '知识负责人', role: 'OWNER' }] }),
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('KnowledgeListPage', () => {
  it('renders knowledge and keeps search filters in the URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ knowledge: [{
      id: 'KNW-1', title: '部署要求', category: 'TECHNICAL', authority: 'L1', ownerId: 'USR-OWNER',
      status: 'ACTIVE', version: 3, indexStatus: 'INDEXED', updatedAt: '2026-08-11T12:00:00.000Z',
    }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter initialEntries={['/factory/knowledge']}><KnowledgeListPage /></MemoryRouter>)
    expect(await screen.findByRole('link', { name: '部署要求' })).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('搜索知识'), '部署')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/knowledge?q=%E9%83%A8%E7%BD%B2', expect.anything())
  })
})
