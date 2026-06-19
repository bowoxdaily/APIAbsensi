const fs = require('fs/promises');
const path = require('path');

async function ensureFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch (error) {
    await fs.writeFile(filePath, '', 'utf8');
  }
}

async function appendJsonLineWithRotate(filePath, payload, options = {}) {
  const maxBytes = Math.max(Number(options.maxBytes || 10 * 1024 * 1024), 1024 * 1024);
  await ensureFile(filePath);

  const line = `${JSON.stringify(payload)}\n`;
  const lineBytes = Buffer.byteLength(line, 'utf8');

  try {
    const stat = await fs.stat(filePath);
    if (stat.size + lineBytes > maxBytes) {
      const rotatedPath = `${filePath}.1`;
      try {
        await fs.unlink(rotatedPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }

      try {
        await fs.rename(filePath, rotatedPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }

      await fs.writeFile(filePath, '', 'utf8');
    }
  } catch (error) {
    // Best effort rotation. Append tetap dijalankan agar log tidak hilang.
  }

  await fs.appendFile(filePath, line, 'utf8');
}

async function readRecentJsonLines(filePath, options = {}) {
  const maxBytes = Math.max(Number(options.maxBytes || 4 * 1024 * 1024), 64 * 1024);
  const maxLines = Math.max(Number(options.maxLines || 10000), 100);

  await ensureFile(filePath);

  const stat = await fs.stat(filePath);
  if (!stat.size) {
    return [];
  }

  const readStart = Math.max(0, stat.size - maxBytes);
  const readLength = stat.size - readStart;
  const file = await fs.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(readLength);
    await file.read(buffer, 0, readLength, readStart);

    let text = buffer.toString('utf8');
    if (readStart > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    const lines = text.split('\n').filter(Boolean);
    const tailLines = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;

    const parsed = [];
    for (const line of tailLines) {
      try {
        parsed.push(JSON.parse(line));
      } catch (error) {
        // Skip line JSON rusak.
      }
    }

    return parsed;
  } finally {
    await file.close();
  }
}

module.exports = {
  ensureFile,
  appendJsonLineWithRotate,
  readRecentJsonLines,
};
