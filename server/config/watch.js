// chokidar hot-reload + validation gate (§2, §5.3).
// Holds the current good config in memory. On a file change we re-validate;
// on success we swap it in and notify listeners (the scheduler reschedules,
// the frontend re-renders via the new etag). On failure we KEEP the old
// config and record a structured error — the panel never goes dark.
import chokidar from 'chokidar';
import { EventEmitter } from 'node:events';
import { loadConfig, publicConfig, CONFIG_DIR } from './loader.js';

export class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this.current = null;       // last good full config
    this.lastError = null;     // { at, errors[] } of the most recent failed reload
    this._watcher = null;
    this._debounce = null;
  }

  // Initial load. A bad config at boot is fatal (nothing good to fall back to).
  start() {
    this.current = loadConfig();
    this._log('loaded', `etag=${this.current.etag}${this.current.usingFallback ? ' (config.example fallback)' : ''}`);
    this._watch();
    return this.current;
  }

  get() { return this.current; }
  getPublic() { return publicConfig(this.current); }
  health() {
    return {
      etag: this.current?.etag || null,
      usingFallback: !!this.current?.usingFallback,
      lastError: this.lastError,
    };
  }

  _watch() {
    // Watch config/ (real edits) and tolerate it not existing yet.
    this._watcher = chokidar.watch(CONFIG_DIR, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    });
    const trigger = (p) => this._scheduleReload(p);
    this._watcher.on('add', trigger).on('change', trigger).on('unlink', trigger);
    this._watcher.on('error', (e) => this._log('watch-error', e.message));
  }

  _scheduleReload(path) {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this._reload(path), 250);
  }

  _reload(path) {
    try {
      const next = loadConfig();
      const changed = next.etag !== this.current?.etag;
      this.current = next;
      this.lastError = null;
      this._log('reloaded', `etag=${next.etag} (changed=${changed}) trigger=${path || '?'}`);
      if (changed) this.emit('change', next);
    } catch (err) {
      const errors = err.errors || [err.message];
      this.lastError = { at: new Date().toISOString(), errors };
      this._log('reject', `keeping previous config; ${errors.length} error(s):`);
      for (const e of errors) this._log('reject', `  - ${e}`);
      // NOTE: deliberately NOT emit('error', …) — a bare 'error' event with no
      // listener makes EventEmitter throw and crash the process. Use 'invalid'.
      this.emit('invalid', this.lastError);
    }
  }

  async stop() {
    clearTimeout(this._debounce);
    if (this._watcher) await this._watcher.close();
  }

  _log(tag, msg) {
    console.log(`[config:${tag}] ${msg}`);
  }
}
