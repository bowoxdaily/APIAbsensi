const fs = require('fs/promises');
const path = require('path');

const logsFilePath = path.join(process.cwd(), 'logs', 'data.txt');

async function ensureLogFile() {
  await fs.mkdir(path.dirname(logsFilePath), { recursive: true });
  try {
    await fs.access(logsFilePath);
  } catch (error) {
    await fs.writeFile(logsFilePath, '', 'utf8');
  }
}

async function getAttlog(req, res) {
  await ensureLogFile();

  const raw = await fs.readFile(logsFilePath, 'utf8');
  const data = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);

  return res.json({
    success: true,
    count: data.length,
    data,
  });
}

module.exports = {
  getAttlog,
};
