/**
 * 私有文件（手册 §9：token 文件权限 0600）。
 *
 * Windows 上没有 POSIX mode，等价做法是删除继承 ACE，只给当前用户完全控制。
 * 统一走 icacls；非 Windows 平台退化为 chmod 0600。
 */
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import path from 'node:path';
import { writeTextAtomic } from './atomic-write.mjs';

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';

/**
 * Windows 上可用的 PowerShell 解释器候选。
 *
 * 优先 Windows PowerShell 5.1（系统自带），再退到 PowerShell 7（pwsh）。
 * 某些环境（例如 CI runner、只装 PS7 的机器）里 5.1 的模块路径会被继承的
 * `PSModulePath` 破坏，导致 `Get-Acl` 无法自动加载；失败的解释器在本进程内
 * 移除后重试下一个，避免反复失败。
 */
const powerShellCandidates = IS_WINDOWS ? ['powershell', 'pwsh'] : [];
let cachedPowerShell = null;

/**
 * Windows 上“系统/管理员”类主体天然可读任意文件，不属于 0600 等价语义要防的对象。
 * 用 SID 判定（与系统语言无关）：SYSTEM、Administrators、LOCAL/NETWORK SERVICE、NT SERVICE\*。
 */
const IGNORED_ACE_SIDS = new Set([
  'S-1-5-18', // NT AUTHORITY\SYSTEM
  'S-1-5-19', // NT AUTHORITY\LOCAL SERVICE
  'S-1-5-20', // NT AUTHORITY\NETWORK SERVICE
  'S-1-5-32-544', // BUILTIN\Administrators
]);

/**
 * 判断 ACE 是否属于可忽略的系统主体。
 * @param {string} sid ACE 的 SID。
 * @returns {boolean} 是否忽略。
 */
function isIgnoredAce(sid) {
  return IGNORED_ACE_SIDS.has(sid) || sid.startsWith('S-1-5-80-'); // NT SERVICE\*
}

/**
 * 用可用的 PowerShell 执行一段脚本。
 * @param {string} script 供 `-Command` 执行的脚本。
 * @returns {Promise<string>} stdout。
 */
async function runPowerShell(script) {
  const candidates = cachedPowerShell ? [cachedPowerShell] : [...powerShellCandidates];
  let lastError;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(
        candidate,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15000 },
      );
      cachedPowerShell = candidate;
      return stdout;
    } catch (error) {
      lastError = error;
      const index = powerShellCandidates.indexOf(candidate);
      if (index >= 0) powerShellCandidates.splice(index, 1);
    }
  }
  throw lastError ?? new Error('未找到可用的 PowerShell');
}

/**
 * 把文件 ACL 收缩为“仅当前用户可访问”。
 * @param {string} filePath 文件绝对路径。
 * @returns {Promise<void>} 完成。
 */
export async function restrictToCurrentUser(filePath) {
  await chmod(filePath, 0o600).catch(() => {});
  if (process.platform !== 'win32') return;
  const { username } = userInfo();
  try {
    await execFileAsync(
      'icacls',
      [filePath, '/inheritance:r', '/grant:r', `${username}:F`],
      { windowsHide: true },
    );
  } catch (error) {
    throw new Error(`无法收缩文件 ACL（${filePath}）：${error.message}`);
  }
}

/**
 * 原子写入私有文本文件并收缩 ACL。
 * @param {string} filePath 目标文件绝对路径。
 * @param {string} content 文本内容。
 * @returns {Promise<void>} 写入完成。
 */
export async function writePrivateFile(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeTextAtomic(filePath, content, { mode: 0o600 });
  await restrictToCurrentUser(filePath);
}

/**
 * 读取私有文件文本。
 * @param {string} filePath 文件绝对路径。
 * @returns {Promise<string>} 去首尾空白后的内容。
 */
export async function readPrivateFile(filePath) {
  return (await readFile(filePath, 'utf8')).trim();
}

/**
 * 判断文件是否满足“仅当前用户”的私有权限。
 * @param {string} filePath 文件绝对路径。
 * @returns {Promise<{ private: boolean, reason?: string, aces?: string[] }>} 判定结果。
 */
export async function checkPrivateFile(filePath) {
  try {
    await stat(filePath);
  } catch {
    return { private: false, reason: 'missing' };
  }
  if (process.platform !== 'win32') {
    const info = await stat(filePath);
    const mode = info.mode & 0o777;
    return mode === 0o600
      ? { private: true }
      : { private: false, reason: `mode=${mode.toString(8)}` };
  }
  // 用 PowerShell 的 Get-Acl 读当前用户 SID + 每条 ACE 的 SID（与系统语言无关）。
  // SELF 用来确认“只授权给了当前用户”；SYSTEM/Administrators 等系统主体忽略（见 IGNORED_ACE_SIDS）。
  const escaped = filePath.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$acl = Get-Acl -LiteralPath '${escaped}'`,
    '$self = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    'Write-Output ("SELF=" + $self)',
    '$aceSids = @($acl.Access | ForEach-Object { try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $_.IdentityReference.Value } })',
    '$aceSids | ForEach-Object { Write-Output ("ACE=" + $_) }',
  ].join('; ');
  let selfSid = null;
  const aces = [];
  try {
    const stdout = await runPowerShell(script);
    for (const line of stdout.split(/\r?\n/)) {
      const value = line.trim();
      if (value.startsWith('SELF=')) selfSid = value.slice('SELF='.length);
      else if (value.startsWith('ACE=')) aces.push(value.slice('ACE='.length));
    }
  } catch (error) {
    return { private: false, reason: `ACL unavailable: ${error.message}` };
  }
  if (!selfSid || aces.length === 0) {
    return { private: false, aces, reason: 'ACL unreadable' };
  }
  const foreign = aces.filter((sid) => sid !== selfSid && !isIgnoredAce(sid));
  if (foreign.length > 0) {
    return { private: false, aces, reason: `foreign ACEs: ${foreign.join(' | ')}` };
  }
  return { private: true, aces };
}
