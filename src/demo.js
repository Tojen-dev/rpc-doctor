import { createServer } from 'node:http';
import { benchmark } from './benchmark.js';

export async function runDemo(options) {
  const servers = [];
  try {
    const urls = [];
    for (const [delay, height, failEvery] of [[5, '0x100', 0], [35, '0xfa', 0], [15, '0x100', 3]]) {
      let calls = 0;
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4096) { res.writeHead(413).end(); return; }
        }
        let request;
        try { request = JSON.parse(body); }
        catch { res.writeHead(400).end(); return; }
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (request.method === 'eth_blockNumber' && failEvery && ++calls % failEvery === 0) {
          res.writeHead(429).end();
          return;
        }
        res.setHeader('content-type', 'application/json');
        if (request.method === 'eth_getBlockByNumber') {
          const historical = delay === 5 ? { result: { number: request.params[0], hash: `0x${'ab'.repeat(32)}` } }
            : delay === 35 ? { result: null } : { error: { code: -32601, message: 'Synthetic method unavailable.' } };
          res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...historical }));
          return;
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x1' : height }));
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      urls.push(`http://127.0.0.1:${server.address().port}`);
    }
    return { ...await benchmark(urls, options), demo: true };
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  }
}
