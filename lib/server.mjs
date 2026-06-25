// Boots a static HTTP server rooted at the design directory so slides render over
// http:// (never file://), letting relative `../` paths and fetch-based logic work.

import http from 'node:http';
import sirv from 'sirv';

/**
 * Start a static server serving `root` on an ephemeral port.
 * @param {string} root absolute path to serve from
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer(root) {
  const serve = sirv(root, { dev: true, etag: false });
  const server = http.createServer((req, res) => serve(req, res, () => {
    res.statusCode = 404;
    res.end('Not found');
  }));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
