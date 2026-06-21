/**
 * Typings for the slice of Electron's `<webview>` element API we call via a ref.
 * The `<webview>` JSX intrinsic itself is already provided by `@types/react`.
 */
export interface PreviewCapture {
  toPNG(): Uint8Array
  toDataURL(): string
  getSize(): { width: number; height: number }
  isEmpty(): boolean
}

export interface PreviewWebview extends HTMLElement {
  src: string
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  loadURL(url: string): Promise<void>
  stop(): void
  capturePage(rect?: {
    x: number
    y: number
    width: number
    height: number
  }): Promise<PreviewCapture>
}
