// Persistencia simple en la carpeta de datos del usuario: recientes, autoguardado y caché de codificadores.
import fs from 'node:fs';
import path from 'node:path';

export class Storage {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) {
    return path.join(this.dir, name);
  }

  readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJson(name, data) {
    writeFileAtomic(this.file(name), JSON.stringify(data, null, 2));
  }

  getRecent() {
    const list = this.readJson('recent.json', []);
    return list.filter((r) => r && r.path && fs.existsSync(r.path)).slice(0, 12);
  }

  addRecent(file, name) {
    const list = this.readJson('recent.json', []).filter((r) => r.path !== file);
    list.unshift({ path: file, name: name || path.basename(file), time: Date.now() });
    this.writeJson('recent.json', list.slice(0, 20));
  }

  autosave(text, meta) {
    writeFileAtomic(this.file('autosave.lcproj'), text);
    this.writeJson('autosave.json', { ...meta, time: Date.now() });
  }

  loadAutosave() {
    try {
      const meta = this.readJson('autosave.json', null);
      if (!meta) return null;
      const text = fs.readFileSync(this.file('autosave.lcproj'), 'utf8');
      return { text, meta };
    } catch {
      return null;
    }
  }

  clearAutosave() {
    fs.rmSync(this.file('autosave.lcproj'), { force: true });
    fs.rmSync(this.file('autosave.json'), { force: true });
  }
}

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Cola de trabajos con concurrencia limitada (para no saturar equipos modestos).
export class JobQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.next();
    });
  }

  next() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.next();
        });
    }
  }
}
