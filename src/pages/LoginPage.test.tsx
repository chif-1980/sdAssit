import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { LoginPage } from './LoginPage'

afterEach(cleanup)

describe('LoginPage', () => {
  it('offers Feishu login as its only primary action', () => {
    render(<LoginPage />)

    const loginLink = screen.getByRole('link', { name: '使用飞书登录' })
    expect(loginLink).toHaveAttribute('href', '/api/auth/feishu/login?return_path=%2Fchat')
    expect(screen.getAllByRole('link')).toEqual([loginLink])
  })

  it('does not expose technical or demonstration controls', () => {
    render(<LoginPage />)

    expect(document.body).not.toHaveTextContent(/演示身份|模型|Agent|智能体|Skill|知识库|回答范围|Factory|Knowledge Factory/iu)
    expect(document.body).not.toHaveTextContent('@')
  })
})
