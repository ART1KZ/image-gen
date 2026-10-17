import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function runtimePaths(env = process.env) {
  let profile = path.resolve(env.IMAGE_GEN_PROFILE_DIR || path.join(root, 'edge-auth-profile'));
  try {profile=realpathSync.native(profile);} catch {}
  const canonicalProfile = process.platform === 'win32' ? profile.toLowerCase() : profile;
  const port=Number(env.IMAGE_GEN_CDP_PORT || 9222);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid browser debugging port');
  const endpoint = `http://localhost:${port}`;
  const namespace = createHash('sha256').update(`${endpoint}\n${canonicalProfile}`).digest('hex').slice(0, 24);
  const base = path.resolve(env.IMAGE_GEN_STATE_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'image-gen'));
  const stateDir = path.join(base, namespace);
  return { namespace, stateDir, secretPath: path.join(stateDir, 'ipc-secret'), registryPath: path.join(stateDir, 'jobs.json'),
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\image-gen-${namespace}` : path.join(stateDir, 'coordinator.sock') };
}

export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Runtime directory must be a real directory');
  if (process.platform === 'win32') {
    // Create a fresh protected ACL, rather than retaining inherited or explicit grants.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:IMAGE_GEN_PRIVATE_DIRECTORY,$acl)'],
    { windowsHide: true, stdio: 'pipe', env: { ...process.env, IMAGE_GEN_PRIVATE_DIRECTORY: directory } });
  } else {
    if (stat.uid !== process.getuid()) throw new Error('Runtime directory belongs to another user');
    await fs.chmod(directory, 0o700);
  }
}

export async function readSecret(paths) {
  const stat = await fs.lstat(paths.secretPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid coordinator credentials');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw new Error('Coordinator credentials are not private');
  const secret = await fs.readFile(paths.secretPath, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid coordinator credentials');
  return secret;
}

export async function ensureRuntime(paths) {
  await ensurePrivateDirectory(paths.stateDir);
  let fd;
  try {
    fd = await fs.open(paths.secretPath, 'wx', 0o600);
    await fd.writeFile(randomBytes(32).toString('hex')); await fd.sync();
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await fd?.close(); }
  // Concurrent initializers may observe the creator before its first write.
  for (let i=0;i<50;i++) {
    try { return await readSecret(paths); }
    catch (error) { if (i===49) throw error; await new Promise(r=>setTimeout(r,10)); }
  }
}

export async function atomicWrite(file, data) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = await fs.open(temporary, 'wx', 0o600);
    try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(()=>{}); }
}
