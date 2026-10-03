import { createServer } from 'node:http';

const requestIds = new WeakMap();

export async function serve(handler) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    let request;
    try { request = JSON.parse(body); }
    catch { res.writeHead(400).end(); return; }
    requestIds.set(res, request.id);
    await handler(request, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}

export function reply(res, result, id = requestIds.get(res)) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
