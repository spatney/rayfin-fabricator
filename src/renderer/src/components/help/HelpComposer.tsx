import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Codicon } from '../icons'
import { useToast } from '../../toast'
import { reportThrown } from '../../errorReport'
import { savePastedImage } from './paste'

export interface HelpComposerProps {
  busy: boolean
  onAsk: (question: string, attachments: string[]) => Promise<void>
  onStop: () => void
}

/** Grow the prompt with its content, up to a third of the window. */
function autoSize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`
}

/**
 * The prompt line. Accepts a question, files and folders the user points at,
 * and images pasted straight from the clipboard (a screenshot of the problem is
 * usually the fastest way to describe it).
 */
export function HelpComposer({ busy, onAsk, onStop }: HelpComposerProps): JSX.Element {
  const toast = useToast()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [dropping, setDropping] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!busy) inputRef.current?.focus()
  }, [busy])

  const addFiles = useCallback((paths: string[]): void => {
    setFiles((prev) => {
      const merged = [...prev]
      for (const path of paths) if (path && !merged.includes(path)) merged.push(path)
      return merged.slice(0, 20)
    })
  }, [])

  const submit = useCallback((): void => {
    const question = text.trim()
    if (!question || busy) return
    const attachments = files
    setText('')
    setFiles([])
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
    }
    void onAsk(question, attachments)
  }, [busy, files, onAsk, text])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // Enter sends; Shift+Enter makes a new line.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        submit()
      }
    },
    [submit]
  )

  const pickFiles = useCallback(async (): Promise<void> => {
    try {
      const picked = await window.api.help.pickPaths(false, 'Attach files for Help to read')
      if (picked.length) addFiles(picked)
    } catch (reason) {
      toast.error(reportThrown(reason, { operation: 'help_attach', area: 'ui' }), {
        title: "Couldn't attach that",
        record: false
      })
    }
  }, [addFiles, toast])

  const pickFolder = useCallback(async (): Promise<void> => {
    try {
      const picked = await window.api.help.pickPaths(true, 'Attach a folder for Help to read')
      if (picked.length) addFiles(picked)
    } catch (reason) {
      toast.error(reportThrown(reason, { operation: 'help_attach', area: 'ui' }), {
        title: "Couldn't attach that",
        record: false
      })
    }
  }, [addFiles, toast])

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
      const images = Array.from(event.clipboardData.files).filter((f) =>
        f.type.startsWith('image/')
      )
      if (images.length === 0) return
      event.preventDefault()
      void (async () => {
        for (const image of images) {
          try {
            addFiles([await savePastedImage(image)])
          } catch (reason) {
            toast.error(reportThrown(reason, { operation: 'help_paste_image', area: 'ui' }), {
              title: "Couldn't attach the image",
              record: false
            })
          }
        }
      })()
    },
    [addFiles, toast]
  )

  // Dropping a file or folder onto the prompt attaches it. The webview gives us
  // real paths only through Tauri's own drop event, so fall back to the name
  // when a plain HTML drop is all we get.
  const onDrop = useCallback(
    (event: React.DragEvent): void => {
      event.preventDefault()
      setDropping(false)
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => (file as File & { path?: string }).path)
        .filter((path): path is string => Boolean(path))
      if (paths.length) addFiles(paths)
    },
    [addFiles]
  )

  return (
    <form
      className={`help-composer ${dropping ? 'is-dropping' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {files.length > 0 && (
        <ul className="help-chips">
          {files.map((path) => (
            <li key={path} title={path}>
              <Codicon name="file" />
              <span>{path.split(/[\\/]/).pop()}</span>
              <button
                type="button"
                aria-label={`Remove ${path}`}
                onClick={() => setFiles((prev) => prev.filter((p) => p !== path))}
              >
                <Codicon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="help-prompt">
        <span className="help-prompt-caret" aria-hidden="true">
          &gt;
        </span>
        <textarea
          ref={inputRef}
          className="help-input"
          rows={1}
          value={text}
          placeholder="Describe what went wrong, or paste a screenshot"
          aria-label="Ask Help"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            autoSize(e.target)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="help-prompt-tools">
          <button type="button" onClick={() => void pickFiles()} title="Attach files">
            <Codicon name="new-file" />
          </button>
          <button type="button" onClick={() => void pickFolder()} title="Attach a folder">
            <Codicon name="folder-opened" />
          </button>
          {busy ? (
            <button type="button" className="help-stop" onClick={onStop} title="Stop (Esc)">
              <Codicon name="primitive-square" />
            </button>
          ) : (
            <button
              type="submit"
              className="help-send"
              disabled={!text.trim()}
              title="Ask (Enter)"
            >
              <Codicon name="arrow-right" />
            </button>
          )}
        </div>
      </div>

      <p className="help-hint">
        <kbd>Enter</kbd> to ask · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line ·{' '}
        <kbd>Esc</kbd> to {busy ? 'stop' : 'close'}
      </p>
    </form>
  )
}
