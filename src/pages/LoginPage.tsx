export function LoginPage() {
  return (
    <main className="center-state">
      <h1>企业知识助手</h1>
      <a
        className="primary-button"
        href="/api/auth/feishu/login?return_path=%2Fchat"
      >
        使用飞书登录
      </a>
    </main>
  )
}
