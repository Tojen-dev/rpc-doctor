import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { endpointLabels } from './labels.js';
import { validateEndpoint } from './rpc.js';

const MAX_CONFIG_BYTES = 64 * 1024;

export class ConfigError extends Error {}

async function readConfig(path) {
  try {
    // Nonblocking open prevents a named pipe from hanging before the file-type check.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new ConfigError('Config must be a regular file.');
      if (stat.size > MAX_CONFIG_BYTES) throw new ConfigError('Config must not exceed 64 KiB.');
      // Bound the actual read too, in case the file grows after stat().
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_CONFIG_BYTES) throw new ConfigError('Config must not exceed 64 KiB.');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('Config could not be read as UTF-8 JSON.');
  }
}

function hasOnlyKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

export async function loadConfig(path, env) {
  const config = await readConfig(path);
  if (!hasOnlyKeys(config, ['endpoints', 'samples', 'timeout'])) {
    throw new ConfigError('Config must be an object containing only endpoints, samples, and timeout.');
  }
  const result = {};
  if (Object.hasOwn(config, 'samples')) {
    if (!Number.isInteger(config.samples) || config.samples < 1 || config.samples > 100) {
      throw new ConfigError('Config samples must be an integer from 1 to 100.');
    }
    result.samples = config.samples;
  }
  if (Object.hasOwn(config, 'timeout')) {
    if (!Number.isInteger(config.timeout) || config.timeout < 1 || config.timeout > 60000) {
      throw new ConfigError('Config timeout must be an integer from 1 to 60000 ms.');
    }
    result.timeoutMs = config.timeout;
  }
  if (Object.hasOwn(config, 'endpoints')) {
    if (!Array.isArray(config.endpoints) || config.endpoints.length < 1 || config.endpoints.length > 20) {
      throw new ConfigError('Config endpoints must be an array of 1 to 20 named endpoints.');
    }
    const urls = [];
    const labels = [];
    for (const endpoint of config.endpoints) {
      if (!hasOnlyKeys(endpoint, ['label', 'url', 'urlEnv']) || !Object.hasOwn(endpoint, 'label')
        || Object.hasOwn(endpoint, 'url') === Object.hasOwn(endpoint, 'urlEnv')) {
        throw new ConfigError('Config endpoints require label and exactly one of url or urlEnv, with no other fields.');
      }
      let url = endpoint.url;
      if (Object.hasOwn(endpoint, 'urlEnv')) {
        const name = endpoint.urlEnv;
        if (typeof name !== 'string' || !/^[A-Za-z_]/.test(name) || /[^A-Za-z0-9_]/.test(name)) {
          throw new ConfigError('Config urlEnv must be an environment variable name.');
        }
        if (!Object.hasOwn(env, name) || typeof env[name] !== 'string' || env[name].trim() === '') {
          throw new ConfigError('Config URL environment reference is missing or empty.');
        }
        url = env[name];
      }
      if (typeof url !== 'string') throw new ConfigError('Config endpoint URLs must be strings.');
      try { urls.push(validateEndpoint(url)); }
      catch { throw new ConfigError('Config endpoint URLs must be HTTP(S), without userinfo or fragments.'); }
      labels.push(endpoint.label);
    }
    if (new Set(urls).size !== urls.length) throw new ConfigError('Config contains duplicate endpoint URLs.');
    try { result.labels = endpointLabels(labels, urls.length); }
    catch { throw new ConfigError('Config endpoint labels must be names of 1–64 characters after normalization, not URLs.'); }
    result.endpoints = urls;
  }
  return result;
}
