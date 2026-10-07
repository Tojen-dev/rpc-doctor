import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { OutputError, prepareOutput } from '../src/output.js';
import { loadConfig } from '../src/config.js';

const posix = process.platform !== 'win32';
const fault = () => Object.assign(new Error('EACCES /SYNTHETIC_SECRET https://private.invalid/key'), { code: 'EACCES' });
const safeFailure = error => error instanceof OutputError && !/SYNTHETIC_SECRET|private\.invalid|EACCES/.test(error.message);
async function sandbox(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'rpc-doctor-output-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = join(directory, 'report');
  await fs.writeFile(join(directory, 'sentinel'), 'unrelated');
  return { directory, destination };
}
async function clean(directory, extra = []) {
  assert.deepEqual((await fs.readdir(directory)).sort(), ['sentinel', ...extra].sort());
  assert.equal(await fs.readFile(join(directory, 'sentinel'), 'utf8'), 'unrelated');
}

test('full UTF-8 writes, sync and close precede atomic publication; replacement never truncates old inode', async t => {
  const { directory, destination } = await sandbox(t);
  await fs.writeFile(destination, 'old report', { mode: 0o644 });
  const alias = join(directory, 'old-hardlink'); await fs.link(destination, alias);
  const order = [];
  const contents = 'Київ 🛰\r\n"a,b","c""d"\r\n'.repeat(100);
  const io = { ...fs,
    open: async (...args) => {
      assert.equal(args[1], 'wx'); assert.equal(args[2], 0o600);
      const handle = await fs.open(...args);
      return {
        chmod: mode => handle.chmod(mode),
        write: async (buffer, offset, length, position) => {
          assert.equal(await fs.readFile(destination, 'utf8'), 'old report');
          order.push('write');
          return handle.write(buffer, offset, Math.min(length, 7), position);
        },
        sync: async () => { order.push('sync'); await handle.sync(); },
        close: async () => { order.push('close'); await handle.close(); },
      };
    },
    rename: async (from, to) => {
      assert.equal(await fs.readFile(destination, 'utf8'), 'old report');
      assert.equal(await fs.readFile(from, 'utf8'), contents);
      assert.deepEqual(order.slice(-2), ['sync', 'close']);
      order.push('rename'); return fs.rename(from, to);
    },
  };
  const publish = await prepareOutput(destination, { overwrite: true }, io);
  await clean(directory, ['report', 'old-hardlink']);
  await publish(contents);
  assert.deepEqual(await fs.readFile(destination), Buffer.from(contents));
  assert.equal(await fs.readFile(alias, 'utf8'), 'old report');
  if (posix) {
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(alias)).mode & 0o777, 0o644);
  }
  assert.equal(order.at(-1), 'rename'); await clean(directory, ['report', 'old-hardlink']);
});

for (const overwrite of [false, true]) {
  for (const phase of ['open', 'chmod', 'write', 'zero-write', 'sync', 'close', 'publish']) {
    test(`${overwrite ? 'replacement' : 'new file'} ${phase} failure leaves destination intact and removes only its temp`, async t => {
      const { directory, destination } = await sandbox(t);
      if (overwrite) await fs.writeFile(destination, 'old report');
      const io = { ...fs, open: async (...args) => {
        if (phase === 'open') throw fault();
        const handle = await fs.open(...args);
        return {
          chmod: async mode => { if (phase === 'chmod') throw fault(); await handle.chmod(mode); },
          write: async (...writeArgs) => {
            if (phase === 'zero-write') return { bytesWritten: 0 };
            if (phase === 'write') { await handle.write(Buffer.from('partial')); throw fault(); }
            return handle.write(...writeArgs);
          },
          sync: async () => { if (phase === 'sync') throw fault(); await handle.sync(); },
          close: async () => { await handle.close(); if (phase === 'close') throw fault(); },
        };
      } };
      if (phase === 'publish') io[overwrite ? 'rename' : 'link'] = async () => { throw fault(); };
      const publish = await prepareOutput(destination, { overwrite }, io);
      await assert.rejects(publish('complete report'), safeFailure);
      if (overwrite) assert.equal(await fs.readFile(destination, 'utf8'), 'old report');
      else await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
      await clean(directory, overwrite ? ['report'] : []);
    });
  }
}

test('exclusive temp collision preserves the colliding file without chmod, write, or unlink', async t => {
  const { directory, destination } = await sandbox(t); let collision;
  const io = { ...fs, open: async (...args) => {
    collision = args[0]; await fs.writeFile(collision, 'foreign temp');
    return fs.open(...args);
  } };
  await assert.rejects((await prepareOutput(destination, {}, io))('report'), safeFailure);
  assert.equal(await fs.readFile(collision, 'utf8'), 'foreign temp');
  await fs.unlink(collision); await clean(directory);
});

test('concurrent no-overwrite publications have exactly one complete winner at the atomic link', async t => {
  const { directory, destination } = await sandbox(t);
  let arrive = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const io = { ...fs, link: async (...args) => {
    if (++arrive === 8) release();
    await gate; return fs.link(...args);
  } };
  const writers = await Promise.all(Array.from({ length: 8 }, () => prepareOutput(destination, {}, io)));
  const reports = writers.map((_, i) => `complete ${i} 🛰\r\n`.repeat(1000));
  const outcomes = await Promise.allSettled(writers.map((write, i) => write(reports[i])));
  const winners = outcomes.flatMap((r, i) => r.status === 'fulfilled' ? [i] : []);
  assert.equal(winners.length, 1); assert.equal(arrive, 8);
  assert.equal(await fs.readFile(destination, 'utf8'), reports[winners[0]]);
  assert.ok(outcomes.filter(r => r.status === 'rejected').every(r => safeFailure(r.reason)));
  await clean(directory, ['report']);
});

test('creation in the final no-overwrite race cannot be clobbered', async t => {
  const { directory, destination } = await sandbox(t);
  const io = { ...fs, link: async (...args) => {
    await fs.writeFile(destination, 'concurrent writer', { flag: 'wx' });
    return fs.link(...args);
  } };
  await assert.rejects((await prepareOutput(destination, {}, io))('our report'), safeFailure);
  assert.equal(await fs.readFile(destination, 'utf8'), 'concurrent writer');
  await clean(directory, ['report']);
});

test('existing regular file requires overwrite, while missing parent and non-directory parent are refused', async t => {
  const { directory, destination } = await sandbox(t);
  await fs.writeFile(destination, 'original');
  await assert.rejects(prepareOutput(destination), /already exists/);
  for (const path of [join(directory, 'missing', 'report'), join(destination, 'report'), directory, `${destination}/`]) {
    await assert.rejects(prepareOutput(path, { overwrite: true }), safeFailure);
  }
  assert.equal(await fs.readFile(destination, 'utf8'), 'original'); await clean(directory, ['report']);
});

test('POSIX leaf links, dangling links, FIFO and device are rejected without following or opening them', { skip: !posix }, async t => {
  const { directory, destination } = await sandbox(t);
  await fs.writeFile(destination, 'original');
  const link = join(directory, 'link'); const dangling = join(directory, 'dangling'); const fifo = join(directory, 'fifo');
  await fs.symlink(destination, link); await fs.symlink(join(directory, 'absent'), dangling);
  execFileSync('mkfifo', [fifo]);
  for (const overwrite of [false, true]) {
    for (const path of [link, dangling, fifo, '/dev/null']) await assert.rejects(prepareOutput(path, { overwrite }), safeFailure);
  }
  assert.equal(await fs.readlink(link), destination); assert.ok((await fs.lstat(dangling)).isSymbolicLink());
  assert.equal(await fs.readFile(destination, 'utf8'), 'original');
  await clean(directory, ['report', 'link', 'dangling', 'fifo']);
});

test('POSIX parent permissions are checked before measurement without creating a probe file', { skip: !posix || process.getuid?.() === 0 }, async t => {
  const { directory, destination } = await sandbox(t);
  await fs.chmod(directory, 0o500);
  try { await assert.rejects(prepareOutput(destination), safeFailure); }
  finally { await fs.chmod(directory, 0o700); }
  await clean(directory);
});

test('injected preflight permission failures are always safe', async t => {
  const { directory, destination } = await sandbox(t);
  await assert.rejects(prepareOutput(destination, {}, { ...fs, access: async () => { throw fault(); } }), safeFailure);
  await clean(directory);
});

test('config inode captured from the read handle stays protected even if the config path changes later', async t => {
  const { directory, destination } = await sandbox(t);
  const configPath = join(directory, 'config.json'); await fs.writeFile(configPath, '{"samples":1}');
  await fs.link(configPath, destination);
  let configIdentity;
  assert.deepEqual(await loadConfig(configPath, {}, { onRead: identity => { configIdentity = identity; } }), { samples: 1 });
  const newer = join(directory, 'new-config'); await fs.writeFile(newer, '{"samples":2}'); await fs.rename(newer, configPath);
  await assert.rejects(prepareOutput(destination, { overwrite: true, configPath, configIdentity }), /input config/);
  assert.equal(await fs.readFile(destination, 'utf8'), '{"samples":1}');
  assert.equal(await fs.readFile(configPath, 'utf8'), '{"samples":2}');
});

test('config direct/relative/canonical paths and hardlinks are protected from overwrite', async t => {
  const { directory, destination } = await sandbox(t);
  const configPath = join(directory, 'config.json'); await fs.writeFile(configPath, '{}'); await fs.link(configPath, destination);
  let configIdentity; await loadConfig(configPath, {}, { onRead: identity => { configIdentity = identity; } });
  for (const path of [configPath, relative(process.cwd(), configPath), join(directory, '.', 'config.json'), destination]) {
    await assert.rejects(prepareOutput(path, { configPath, configIdentity, overwrite: true }), /input config/);
  }
  assert.equal(await fs.readFile(configPath, 'utf8'), '{}'); await clean(directory, ['config.json', 'report']);
});

test('POSIX config symlinks and parent aliases cannot conceal config identity; parent .. uses OS resolution', { skip: !posix }, async t => {
  const { directory } = await sandbox(t);
  const sub = join(directory, 'sub'); await fs.mkdir(sub);
  const deep = join(sub, 'deep'); await fs.mkdir(deep);
  const alias = join(directory, 'alias'); await fs.symlink(deep, alias);
  const configPath = join(sub, 'config.json'); await fs.writeFile(configPath, '{}');
  const configLink = join(directory, 'config-link'); await fs.symlink(configPath, configLink);
  const viaParent = `${alias}/../config.json`;
  for (const input of [configPath, configLink, viaParent]) {
    let configIdentity; await loadConfig(input, {}, { onRead: id => { configIdentity = id; } });
    for (const destination of [configPath, configLink, viaParent]) {
      await assert.rejects(prepareOutput(destination, { configPath: input, configIdentity, overwrite: true }), safeFailure);
    }
  }
  assert.equal(await fs.readFile(configPath, 'utf8'), '{}');
  await (await prepareOutput(`${alias}/../new-report`))('correct parent');
  assert.equal(await fs.readFile(join(sub, 'new-report'), 'utf8'), 'correct parent');
  await assert.rejects(fs.lstat(join(directory, 'new-report')), { code: 'ENOENT' });
});

test('last pre-publication check refuses newly introduced config hardlinks and leaf symlinks', async t => {
  for (const type of ['config', ...(posix ? ['symlink'] : [])]) {
    const { directory, destination } = await sandbox(t);
    const configPath = join(directory, 'config.json'); await fs.writeFile(configPath, '{}');
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return { chmod: mode => handle.chmod(mode), write: (...args) => handle.write(...args), close: () => handle.close(),
        sync: async () => {
          await handle.sync();
          if (type === 'config') await fs.link(configPath, destination);
          else await fs.symlink(configPath, destination);
        },
      };
    } };
    const publish = await prepareOutput(destination, { overwrite: true, configPath }, io);
    await assert.rejects(publish('report'), safeFailure);
    assert.equal(await fs.readFile(configPath, 'utf8'), '{}');
    assert.equal(await fs.readFile(destination, 'utf8'), '{}');
    await clean(directory, ['report', 'config.json']);
  }
});

test('failed post-link cleanup reports an error without rolling back or corrupting the complete destination', async t => {
  const { directory, destination } = await sandbox(t);
  const io = { ...fs, unlink: async () => { throw fault(); } };
  await assert.rejects((await prepareOutput(destination, {}, io))('complete'), /cleanup failed; a complete report may already be published/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'complete');
  const temps = (await fs.readdir(directory)).filter(name => name.startsWith('.rpc-doctor-'));
  assert.equal(temps.length, 1); assert.equal(await fs.readFile(join(directory, temps[0]), 'utf8'), 'complete');
  await fs.unlink(join(directory, temps[0])); await clean(directory, ['report']);
});
