import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';

export class OutputError extends Error {}

export function validateOutputOptions(values, tokens) {
  if (['output', 'overwrite'].some(name => tokens.filter(t => t.kind === 'option' && t.name === name).length > 1)) {
    throw new OutputError('Use --output and --overwrite at most once each.');
  }
  if (values.overwrite && values.output === undefined) throw new OutputError('Use --overwrite only with --output.');
  if (values.output !== undefined && (values.output.trim() === '' || values.output.includes('\0'))) {
    throw new OutputError('Output must be a nonempty file path without NUL characters.');
  }
}

const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
async function optionalStat(io, path) {
  try { return await io.lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
const safeError = error => error instanceof OutputError ? error
  : new OutputError('Report file operation failed.');

// Preflight is read-only. It does not reserve the destination or create a temp.
// The injected IO is used by failure tests, never by CLI/config input.
export async function prepareOutput(path, { overwrite = false, configPath, configIdentity } = {}, io = fs) {
  try {
    const leaf = basename(path);
    if (!leaf || leaf === '.' || leaf === '..' || path.endsWith(sep)) {
      throw new OutputError('Output must name a regular file, not a directory.');
    }
    // Resolve the parent through the OS before appending the leaf; resolve(path)
    // alone would incorrectly collapse '..' across a symlinked parent.
    const parent = await io.realpath(dirname(path));
    if (!(await io.stat(parent)).isDirectory()) throw new OutputError('Output parent must be an existing directory.');
    const destination = join(parent, leaf);
    const configCanonical = configPath === undefined ? undefined : await io.realpath(configPath);
    const configAbsolute = configPath === undefined ? undefined : resolve(configPath);

    async function checkDestination() {
      const current = await optionalStat(io, destination);
      if (current && !current.isFile()) throw new OutputError('Output destination must be a regular file; links and special files are refused.');
      if (configPath !== undefined) {
        const currentConfig = await io.stat(configPath, { bigint: true });
        const currentCanonical = await io.realpath(configPath);
        if ([configCanonical, configAbsolute, currentCanonical].includes(destination)
          || sameFile(current, configIdentity) || sameFile(current, currentConfig)) {
          throw new OutputError('Output destination must not be the input config or an alias of it.');
        }
      }
      if (current && !overwrite) throw new OutputError('Output destination already exists; use --overwrite to replace a regular file.');
    }
    await checkDestination();
    // Advisory only: permissions and names can change before publication.
    await io.access(parent, constants.W_OK | constants.X_OK);

    return async function publishReport(text) {
      let file;
      let ownedTemp;
      let failure;
      try {
        const bytes = Buffer.from(text, 'utf8');
        const temporary = join(parent, `.rpc-doctor-${randomUUID()}.tmp`);
        file = await io.open(temporary, 'wx', 0o600);
        ownedTemp = temporary; // Never unlink a colliding name that we did not create.
        await file.chmod(0o600); // Only our private inode, never an existing destination.
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) {
            throw new OutputError('Report file write did not complete.');
          }
          offset += bytesWritten;
        }
        await file.sync();
        // A failed close is a publication failure. Do not retry a possibly closed
        // descriptor, which an OS may already have made available for reuse.
        const closing = file;
        file = undefined;
        await closing.close();
        await checkDestination();
        if (overwrite) {
          await io.rename(ownedTemp, destination);
          ownedTemp = undefined;
        } else {
          // Atomic no-clobber publication, including creation after preflight.
          // No exists-then-rename and no copy fallback on unsupported filesystems.
          await io.link(ownedTemp, destination);
        }
      } catch (error) { failure = safeError(error); }
      finally {
        if (file) {
          try { await file.close(); }
          catch { failure ??= new OutputError('Report file close failed.'); }
        }
        if (ownedTemp) {
          try { await io.unlink(ownedTemp); }
          catch { failure = new OutputError('Report temporary-file cleanup failed; a complete report may already be published.'); }
        }
      }
      if (failure) throw failure;
    };
  } catch (error) { throw safeError(error); }
}
