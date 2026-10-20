/**
 * 项目路径解析。
 * 所有脚本/模块统一从这里取工程根目录，避免依赖当前工作目录。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 工程根目录（scripts/lib/core/ 的上三级）。 */
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * 拼出工程内绝对路径。
 * @param {...string} parts 相对工程根目录的路径片段。
 * @returns {string} 绝对路径。
 */
export function projectPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}
