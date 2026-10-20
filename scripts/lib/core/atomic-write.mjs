/**
 * 原子写文件（手册 §9：写临时文件 → rename，NTFS 上 rename 原子）。
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * 原子写入文本：先写同目录临时文件，再 rename 覆盖目标。
 * @param {string} filePath 目标文件绝对路径。
 * @param {string} content 文本内容。
 * @param {{ mode?: number }} [options] 文件权限，默认 0o600。
 * @returns {Promise<void>} 写入完成。
 */
export async function writeTextAtomic(filePath, content, options = {}) {
  const mode = options.mode ?? 0o600;
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 原子写入 JSON（2 空格缩进 + 末尾换行）。
 * @param {string} filePath 目标文件绝对路径。
 * @param {unknown} value 可序列化值。
 * @param {{ mode?: number }} [options] 文件权限。
 * @returns {Promise<void>} 写入完成。
 */
export async function writeJsonAtomic(filePath, value, options = {}) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
