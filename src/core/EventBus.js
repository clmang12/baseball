// Minimal pub/sub. GameLoop is the only publisher of state changes; renderer,
// HUD and audio subscribe. A throwing listener is logged and isolated so one
// broken subscriber can't stall the game loop.

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /** Subscribes and returns an unsubscribe function. */
  on(type, fn) {
    let set = this._listeners.get(type);
    if (!set) this._listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    const set = this._listeners.get(type);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this._listeners.delete(type);
  }

  emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    // Snapshot so listeners may unsubscribe during dispatch.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] listener for "${type}" threw`, err);
      }
    }
  }

  clear() {
    this._listeners.clear();
  }
}
