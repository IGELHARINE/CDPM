// 버전은 package.json 한 곳에서만 관리한다 (dist/version.js 기준으로 ../package.json).
import { createRequire } from 'node:module';

export const VERSION: string = createRequire(import.meta.url)('../package.json').version;
