import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcCall, parseQuantity, validateEndpoint } from '../src/rpc.js';
import { serve, reply } from './helpers.js';

test('sends JSON-RPC and measures a successful response', async (t) => {
  const server = await serve((req, res) => {
    assert.deepEqual(req, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    reply(res, '0x1');
  });
  t.after(server.close);
  const response = await rpcCall(server.url, 'eth_chainId');
  assert.equal(response.result, '0x1');
  assert.ok(response.durationMs >= 0);
});

test('rejects malformed quantities and preserves large integers', () => {
  assert.equal(parseQuantity('0x20000000000001'), 9007199254740993n);
  for (const value of ['0x', '0x01', '1', '-0x1', 1, null]) {
    assert.throws(() => parseQuantity(value), { code: 'INVALID_RESULT' });
  }
});

test('rejects unsupported and credential-bearing URLs without echoing input', () => {
  for (const value of ['file:///secret', 'https://user:SECRET@example.com', 'https://example.com/#SECRET']) {
    assert.throws(() => validateEndpoint(value), (error) => error.code === 'INVALID_URL' && !error.message.includes('SECRET'));
  }
});

test('classifies rate limiting without returning the provider body', async (t) => {
  const server = await serve((req, res) => res.writeHead(429).end('SECRET'));
  t.after(server.close);
  await assert.rejects(rpcCall(server.url, 'eth_chainId'), { code: 'RATE_LIMITED', message: 'HTTP 429.' });
});

test('times out even when the response body stalls after headers', async (t) => {
  const server = await serve((req, res) => { res.writeHead(200); res.write('{'); });
  t.after(server.close);
  await assert.rejects(rpcCall(server.url, 'eth_chainId', [], { timeoutMs: 60 }), { code: 'TIMEOUT' });
});

test('rejects invalid JSON, mismatched ids, and ambiguous envelopes', async (t) => {
  for (const body of ['not JSON', '{"jsonrpc":"2.0","id":2,"result":"0x1"}',
    '{"jsonrpc":"2.0","id":1,"result":"0x1","error":{}}',
    '{"jsonrpc":"2.0","id":1,"error":null}']) {
    const server = await serve((req, res) => res.end(body));
    t.after(server.close);
    await assert.rejects(rpcCall(server.url, 'eth_chainId'), { code: 'INVALID_RESPONSE' });
  }
});

test('redacts remote RPC error messages', async (t) => {
  const server = await serve((req, res) => res.end(JSON.stringify({
    jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'SECRET_API_KEY' },
  })));
  t.after(server.close);
  await assert.rejects(rpcCall(server.url, 'eth_chainId'), { code: 'RPC_ERROR', message: 'JSON-RPC error -32601.' });
});

test('rejects oversized bodies and refuses redirects', async (t) => {
  const oversized = await serve((req, res) => res.end('x'.repeat(1024 * 1024 + 1)));
  const redirected = await serve((req, res) => res.writeHead(302, { location: oversized.url }).end());
  t.after(oversized.close);
  t.after(redirected.close);
  await assert.rejects(rpcCall(oversized.url, 'eth_chainId'), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(rpcCall(redirected.url, 'eth_chainId'), { code: 'NETWORK_ERROR' });
});
