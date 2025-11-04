import { Miniflare, Log, Request } from 'miniflare';
import http from 'http';
import fs from 'fs';
import path from 'path';

const mf = new Miniflare({
  scriptPath: 'dist/index.js',
  durableObjects: {
    CHAT_ROOM: 'ChatRoom',
  },
  modules: true,
  watch: true,
  log: new Log(),
});

const worker = await mf.getWorker();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Try to serve static file
  const filePath = path.join(process.cwd(), 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    let contentType = 'application/octet-stream';
    if (ext === '.html') contentType = 'text/html;charset=UTF-8';
    if (ext === '.js') contentType = 'application/javascript';
    if (ext === '.css') contentType = 'text/css';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Otherwise, pass to worker
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
  });
  const response = await worker.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) {
    for await (const chunk of response.body) {
      res.write(chunk);
    }
  }
  res.end();
});

const port = 8787;
server.listen(port, () => {
  console.log(`[miniflare] Ready on http://127.0.0.1:${port}`);
});

process.on('SIGINT', async () => {
  console.log('[miniflare] Shutting down...');
  server.close();
  await mf.dispose();
  process.exit(0);
});