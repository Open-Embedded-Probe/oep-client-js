// @ts-check
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import './build-site.js';

const root = resolve('site');
const port = Number(process.env.OEP_CLIENT_JS_PORT) || 4173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  let path = normalize(join(root, pathname));
  if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) { response.writeHead(404).end('Not found'); return; }
  response.setHeader('Content-Type', types[/** @type {keyof typeof types} */ (extname(path))] ?? 'application/octet-stream');
  createReadStream(path).pipe(response);
}).listen(port, () => console.log(`oep-client-js: http://localhost:${port}/`));
