/** Last segment of a POSIX or Windows path. */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Join an absolute folder and a `/`-separated relative path, using the folder's separator. */
export function join(folder: string, relPath: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  const base = folder.replace(/[\\/]+$/, '');
  const rel = relPath
    .replace(/^[\\/]+/, '')
    .split(/[\\/]/)
    .join(sep);
  return `${base}${sep}${rel}`;
}
