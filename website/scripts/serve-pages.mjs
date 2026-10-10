import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '/rayfin-fabricator';
const PORT = Number(process.env.PORT ?? 4321);
const TYPES = new Map([['.html','text/html; charset=utf-8'],['.css','text/css; charset=utf-8'],['.js','application/javascript; charset=utf-8'],['.json','application/json; charset=utf-8'],['.md','text/markdown; charset=utf-8'],['.txt','text/plain; charset=utf-8'],['.xml','application/xml; charset=utf-8'],['.png','image/png'],['.svg','image/svg+xml'],['.ico','image/x-icon'],['.woff2','font/woff2'],['.webp','image/webp'],['.mp4','video/mp4'],['.vtt','text/vtt; charset=utf-8']]);

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  if (!decoded.startsWith(BASE_PATH)) return null;
  let rel = decoded.slice(BASE_PATH.length) || '/';
  rel = rel.replace(/^\/+/, '');
  const full = path.resolve(OUT, rel);
  if (!full.startsWith(OUT)) return null;
  return full;
}
function resolveFile(full) {
  const candidates = [full, `${full}.html`, path.join(full, 'index.html')];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return { file: c, status: 200 };
  const notFound = path.join(OUT, '404.html');
  return { file: existsSync(notFound) ? notFound : null, status: 404 };
}

const server = createServer((req, res) => {
  const base = safePath(req.url ?? '/');
  const result = base ? resolveFile(base) : { file: path.join(OUT, '404.html'), status: 404 };
  if (!result.file) { res.writeHead(404); res.end('Not found'); return; }
  const type = result.file.endsWith(`${path.sep}api${path.sep}search`) ? 'application/json; charset=utf-8' : (TYPES.get(path.extname(result.file)) ?? 'application/octet-stream');
  // Byte ranges, as Pages serves them, so the intro video can seek.
  const size = statSync(result.file).size;
  const range = result.status === 200 ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '') : null;
  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
    createReadStream(result.file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(result.status, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  createReadStream(result.file).pipe(res);
});
server.listen(PORT, () => console.log(`Serving ${OUT} at http://localhost:${PORT}${BASE_PATH}/`));
