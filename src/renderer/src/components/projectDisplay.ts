/** A project folder for display: the Windows user folder shortened to `~`. */
export function displayPath(path: string): string {
  return path.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/])/i, '~').replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, '~')
}
