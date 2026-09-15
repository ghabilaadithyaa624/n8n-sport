// Tiny file-backed store. No native modules (sqlite/postgres drivers) so there's
// nothing that can fail to compile on a fresh machine — swap this out for a real
// database later without touching the route logic below.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function load(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // A half-written file should never take the whole API down.
    console.error(`[db] ${name}.json was unreadable, starting fresh:`, e.message);
    return [];
  }
}

// Write-then-rename so a crash mid-write never corrupts the real file.
function saveAll(name, records) {
  const p = filePath(name);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, p);
}

function append(name, record) {
  const records = load(name);
  records.push(record);
  saveAll(name, records);
  return record;
}

module.exports = { load, saveAll, append };
