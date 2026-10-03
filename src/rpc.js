const MAX_RESPONSE_BYTES = 1024 * 1024;

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export function validateEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new RpcError('INVALID_URL', 'Use an HTTP(S) endpoint without URL userinfo or a fragment.');
  }
}

export function parseQuantity(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new RpcError('INVALID_RESULT', 'Expected a canonical hexadecimal quantity.');
  }
  return BigInt(value);
}

async function readBody(response) {
  if (!response.body) throw new RpcError('INVALID_RESPONSE', 'Empty response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RpcError('RESPONSE_TOO_LARGE', 'Response exceeds 1 MiB.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RpcError('INVALID_RESPONSE', 'Response is not valid JSON.'); }
}

export async function rpcCall(endpoint, method, params = [], { timeoutMs = 5000, id = 1 } = {}) {
  const url = validateEndpoint(endpoint);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new RpcError('INVALID_TIMEOUT', 'Timeout must be an integer from 1 to 60000 ms.');
  }
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RpcError('INVALID_ID', 'Request ID must be a positive safe integer.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RpcError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', `HTTP ${response.status}.`);
    }
    const data = await readBody(response);
    if (!data || Array.isArray(data) || data.jsonrpc !== '2.0' || data.id !== id ||
        Object.hasOwn(data, 'result') === Object.hasOwn(data, 'error')) {
      throw new RpcError('INVALID_RESPONSE', 'Invalid JSON-RPC response envelope.');
    }
    if (Object.hasOwn(data, 'error')) {
      if (!data.error || !Number.isInteger(data.error.code) || typeof data.error.message !== 'string') {
        throw new RpcError('INVALID_RESPONSE', 'Invalid JSON-RPC error envelope.');
      }
      // Provider messages can reflect API keys or URLs. Never propagate them.
      throw new RpcError('RPC_ERROR', `JSON-RPC error ${data.error.code}.`);
    }
    return { result: data.result, durationMs: performance.now() - started };
  } catch (error) {
    if (controller.signal.aborted) throw new RpcError('TIMEOUT', `Request exceeded ${timeoutMs} ms.`);
    if (error instanceof RpcError) throw error;
    throw new RpcError('NETWORK_ERROR', 'Connection failed or redirect was refused.');
  } finally {
    clearTimeout(timer);
  }
}
