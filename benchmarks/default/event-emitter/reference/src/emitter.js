export class EventEmitter {
  constructor() { this.listeners = new Map(); }
  assertEvent(event) { if (typeof event !== 'string') throw new TypeError('event must be a string'); }
  add(event, callback, once) {
    this.assertEvent(event);
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const record = { callback, once };
    const rows = this.listeners.get(event) ?? new Set();
    rows.add(record); this.listeners.set(event, rows);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(event);
      current?.delete(record);
      if (current?.size === 0) this.listeners.delete(event);
    };
  }
  on(event, callback) { return this.add(event, callback, false); }
  once(event, callback) { return this.add(event, callback, true); }
  emit(event, ...args) {
    this.assertEvent(event);
    const snapshot = [...(this.listeners.get(event) ?? [])];
    let called = 0;
    for (const row of snapshot) {
      if (row.once) this.listeners.get(event)?.delete(row);
      row.callback(...args);
      called++;
    }
    if (this.listeners.get(event)?.size === 0) this.listeners.delete(event);
    return called;
  }
  clear(event) {
    if (event === undefined) { const had = this.listeners.size > 0; this.listeners.clear(); return had; }
    this.assertEvent(event);
    return this.listeners.delete(event);
  }
}
