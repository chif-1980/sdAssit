import type { ConversationMessage } from '../../../shared/domain/models.js'

interface MessageThreadProps {
  messages: ConversationMessage[]
  onCitation: (citation: ConversationMessage['citations'][number]) => void
}

export function MessageThread({ messages, onCitation }: MessageThreadProps) {
  return (
    <div className="message-thread" aria-label="消息线程">
      {messages.map((message) => (
        <article key={message.id} className={`message-bubble message-${message.role.toLowerCase()}`}>
          <div className="message-role">{message.role === 'USER' ? '你' : '知识问答'}</div>
          <p>{message.text}</p>
          {message.citations.length ? (
            <div className="message-citations" aria-label="回答引用">
              {message.citations.map((citation, index) => (
                <button
                  type="button"
                  className="citation-button"
                  key={`${citation.knowledgeId}:${citation.assetId}:${citation.locator}`}
                  aria-label={`[${index + 1}]`}
                  onClick={() => onCitation(citation)}
                >
                  [{index + 1}]
                </button>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  )
}
