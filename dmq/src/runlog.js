import fs from 'fs';
import path from 'path';

export function makeRunLogger(runLogPath) {
  return function appendRunLog(status, detail = '') {
    const line = `[${new Date().toISOString()}] ${status}${detail ? ' | ' + detail : ''}\n`;
    try {
      fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
      fs.appendFileSync(runLogPath, line, 'utf8');
    } catch (error) {
      // A log we cannot write must not take the run down with it.
      console.error(`Failed to write run log at ${runLogPath}:`, error.message);
    }
    console.log(line.trimEnd());
  };
}
