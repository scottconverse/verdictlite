import { rmSync } from 'node:fs';
import { TEST_ROOT } from './root.js';

/** All test repos live under one temp folder; remove it before and after the run. */
export default function setup(): () => void {
  rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 3 });
  return () => rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 3 });
}
