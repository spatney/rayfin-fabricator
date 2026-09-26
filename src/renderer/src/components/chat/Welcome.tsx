import type { Suggestion } from '@shared/ipc'
import { FabricatorMark } from '../FabricatorMark'
import { Codicon } from '../icons'

/** The empty chat: a warm hello, idea cards grounded in the app, and a few tips. */
export function Welcome({
  projectName,
  suggestions,
  tailoring,
  generated,
  onPick,
  onRefresh
}: {
  projectName: string
  suggestions: Suggestion[]
  /** Copilot is still generating ideas from the app's code. */
  tailoring: boolean
  /** The ideas shown came from Copilot (and can be refreshed). */
  generated: boolean
  onPick: (text: string) => void
  onRefresh: () => void
}): JSX.Element {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-mark" aria-hidden="true">
        <FabricatorMark />
      </div>
      <h2 className="chat-welcome-title">Let’s build {projectName}</h2>
      <p className="chat-welcome-sub">
        Describe what you want in plain language. I’ll write the code and deploy it live — no coding
        required.
      </p>
      <div className="chat-ideas">
        <div className="chat-ideas-head">
          <span className={`chat-ideas-label${tailoring ? ' shimmer-text' : ''}`}>
            {tailoring ? 'Tailoring ideas to your app…' : 'Ideas to start with'}
          </span>
          {generated && !tailoring && (
            <button
              type="button"
              className="chat-ideas-refresh"
              onClick={onRefresh}
              title="Generate fresh ideas from your app's code"
            >
              <Codicon name="refresh" /> Refresh
            </button>
          )}
        </div>
        <div className="chat-suggestions" aria-busy={tailoring}>
          {suggestions.map((s) => (
            <button
              key={s.text}
              type="button"
              className="chat-suggestion"
              onClick={() => onPick(s.text)}
            >
              <span className="chat-suggestion-icon" aria-hidden="true">
                {s.icon}
              </span>
              <span className="chat-suggestion-text">{s.text}</span>
              <Codicon name="arrow-right" className="chat-suggestion-arrow" />
            </button>
          ))}
        </div>
      </div>
      <ul className="chat-welcome-tips" aria-label="Tips">
        <li>
          <Codicon name="device-camera" /> Paste or drop a screenshot
        </li>
        <li>
          <Codicon name="mention" /> Type <kbd>@</kbd> to reference a file
        </li>
        <li>
          <Codicon name="add" /> Use <kbd>+</kbd> to connect data
        </li>
      </ul>
    </div>
  )
}
