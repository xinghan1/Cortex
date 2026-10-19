import { realpathSync } from 'node:fs';
import os from 'node:os';

// Windows runners can expose TEMP as an 8.3 alias (for example RUNNER~1).
// Fixtures must use the same canonical paths as the production security checks
// and PowerShell, without relaxing checks against junctions or replaced roots.
export const testTempRoot = realpathSync.native(os.tmpdir());
