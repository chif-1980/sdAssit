import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReviewListPage } from './ReviewListPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ReviewListPage', () => {
  it('shows HIGH risk reviews first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ reviews: [
      { id: 'RVW-HIGH', title: '参数冲突', reviewType: 'CONFLICT', risk: 'HIGH', status: 'PENDING', createdAt: '2026-08-11T12:00:00.000Z' },
      { id: 'RVW-LOW', title: '新增问答', reviewType: 'NEW', risk: 'LOW', status: 'PENDING', createdAt: '2026-08-11T13:00:00.000Z' },
    ] }), { status: 200 })))

    render(<MemoryRouter><ReviewListPage /></MemoryRouter>)
    const links = await screen.findAllByRole('link')

    expect(links.map((link) => link.textContent)).toEqual(['参数冲突', '新增问答'])
  })
})
