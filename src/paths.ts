import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function cdpmHome(): string {
  if (process.env.CDPM_HOME) return process.env.CDPM_HOME;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'cdpm');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'cdpm');
  return path.join(os.homedir(), '.cdpm');
}

export const paths = {
  registry: () => path.join(cdpmHome(), 'registry.json'),
  lock: () => path.join(cdpmHome(), 'registry.lock'),
  messages: (slot: number) => path.join(cdpmHome(), 'messages', `${slot}.jsonl`),
  cursors: (slot: number) => path.join(cdpmHome(), 'messages', `${slot}.cursors.json`),
  profile: (slot: number) => path.join(cdpmHome(), 'profiles', String(slot)),
  icon: (slot: number) => path.join(cdpmHome(), 'icons', `${slot}.ico`),
  config: () => path.join(cdpmHome(), 'config.json'),
};

export interface CdpmConfig {
  chromePath?: string;
  extraArgs?: string[];
}

export function readConfig(): CdpmConfig {
  try {
    return JSON.parse(fs.readFileSync(paths.config(), 'utf8')) as CdpmConfig;
  } catch {
    return {};
  }
}

/**
 * MCP·상태줄에 등록할 node 경로. 맥 Homebrew는 process.execPath가 버전 폴더(.../Cellar/node/26.7.0/bin/node)로
 * 나와서 `brew upgrade node` 뒤에 사라지므로, 버전이 바뀌어도 따라가는 opt 바로가기(.../opt/node/bin/node)로 바꾼다.
 * 바로가기가 없거나 다른 OS면 그대로 쓴다.
 */
export function stableNodePath(execPath = process.execPath, exists: (p: string) => boolean = fs.existsSync): string {
  const m = /^(.+)\/Cellar\/(node(?:@[\w.]+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!m) return execPath;
  const stable = `${m[1]}/opt/${m[2]}/bin/node`;
  return exists(stable) ? stable : execPath;
}
