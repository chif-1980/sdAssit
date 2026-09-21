/** Only local conversation/meeting destinations may survive authentication. */
export function safeReturnPath(value: string | null): string {
  if (!value?.startsWith('/chat')) return '/chat'
  try {
    const url = new URL(value, window.location.origin)
    const entries = [...url.searchParams]
    if (url.origin !== window.location.origin || url.pathname !== '/chat' || url.hash
      || new Set(entries.map(([key]) => key)).size !== entries.length
      || entries.some(([key, val]) => !['conversationId', 'meetingId'].includes(key) || !/^[A-Za-z0-9_-]{1,100}$/.test(val))) return '/chat'
    return `/chat${url.search}`
  } catch {
    return '/chat'
  }
}
