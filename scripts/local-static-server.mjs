/**
 * 로컬 미리보기용 정적 서버 (기본 5173, 사용 중이면 다음 포트 자동 시도)
 * Firebase 클라이언트는 file:// 보다 localhost가 안전합니다.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT_ENV = process.env.PORT;
const BASE_PORT = Number(PORT_ENV) || 5173;
const PORT_LOCKED = Boolean(PORT_ENV);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};

function safePath(urlPath) {
  const dec = decodeURIComponent((urlPath || '/').split('?')[0]);
  if (dec.includes('\0')) return null;
  const rel = dec.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT, rel);
  const rootNorm = path.resolve(ROOT);
  if (resolved !== rootNorm && !resolved.startsWith(rootNorm + path.sep)) return null;
  return resolved;
}

function sendFile(res, filePath, method) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }

  let filePath = safePath(req.url === '/' ? '/index.html' : req.url);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    sendFile(res, filePath, req.method);
  });
});

function printUrls(port) {
  const baseIp = `http://127.0.0.1:${port}`;
  const baseLocal = `http://localhost:${port}`;
  console.log(`로컬 서버: ${baseLocal}/  (또는 ${baseIp}/)`);
  console.log(`  앱:     ${baseLocal}/index.html`);
  console.log(`  관리자: ${baseLocal}/soop-stocks-admin-gate16103.html`);
  console.log(
    'Firebase: 익명 로그인 오류 시 → 브라우저는 localhost URL 사용, 또는 Console에 127.0.0.1 허용 도메인 추가'
  );
  console.log('중지: Ctrl+C');
}

function listenOn(port) {
  server.listen(port, '127.0.0.1', () => {
    printUrls(port);
  });
}

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(err);
    process.exit(1);
  }
  const next = port + 1;
  if (!PORT_LOCKED && next <= BASE_PORT + 20) {
    console.warn(`포트 ${port} 사용 중 → ${next} 로 다시 시도합니다.`);
    port = next;
    setImmediate(() => listenOn(port));
    return;
  }
  console.error(
    `\n포트 ${port}가 이미 사용 중입니다 (EADDRINUSE).\n\n` +
      `다른 포트로 실행:\n  PORT=${port + 1} npm run serve\n\n` +
      `이미 떠 있는 서버를 끄려면 (macOS):\n  lsof -ti :${port} | xargs kill\n`
  );
  process.exit(1);
});

let port = BASE_PORT;
listenOn(port);
