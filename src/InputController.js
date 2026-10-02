// Pointer / touch / keyboard → semantic intents for GameLoop (docs §7.2).
// Every intent carries the DOM event timestamp so GameLoop can place meter
// locks and swings at the exact sim time, independent of frame rate.

const KEYMAP = {
  ' ': 'press', Enter: 'continue', Escape: 'pause', p: 'pause', P: 'pause',
  r: 'replay', R: 'replay', v: 'view', V: 'view',
};

export class InputController {
  /**
   * @param {object} o
   * @param {HTMLElement} o.surface           element that receives pointer input (the game stage)
   * @param {(x:number,y:number)=>({x:number,y:number}|null)} o.toPlate  client px → plate-plane world point
   * @param {(intent:object)=>void} o.onIntent
   */
  constructor({ surface, toPlate, onIntent }) {
    this.surface = surface;
    this.toPlate = toPlate;
    this.onIntent = onIntent;
    this.keyAim = null;
    this.enabled = true;
    this._handlers = [];
    this._bind();
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._handlers.push(() => target.removeEventListener(type, fn, opts));
  }

  /** Ignore input aimed at HUD controls (buttons, menus). */
  _isUi(e) {
    return Boolean(e.target?.closest?.('[data-ui]'));
  }

  _emitAim(clientX, clientY, ts) {
    const p = this.toPlate(clientX, clientY);
    if (p) this.onIntent({ type: 'aim', x: p.x, y: p.y, ts });
  }

  _bind() {
    const s = this.surface;
    this._on(window, 'pointermove', (e) => {
      if (!this.enabled || this._isUi(e)) return;
      if (e.pointerType === 'touch' && e.buttons === 0) return;
      this._emitAim(e.clientX, e.clientY, e.timeStamp);
    }, { passive: true });

    this._on(s, 'pointerdown', (e) => {
      if (!this.enabled || e.button > 0 || this._isUi(e)) return;
      if (e.pointerType === 'touch') this._emitAim(e.clientX, e.clientY, e.timeStamp);
      this.onIntent({ type: 'press', pointerType: e.pointerType, ts: e.timeStamp });
    });

    this._on(window, 'pointerup', (e) => {
      if (!this.enabled || e.button > 0 || this._isUi(e)) return;
      this.onIntent({ type: 'release', pointerType: e.pointerType, ts: e.timeStamp });
    });

    // Prevent the browser from scrolling/zooming while aiming on touch screens.
    s.style.touchAction = 'none';

    this._on(window, 'keydown', (e) => {
      if (!this.enabled || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target?.closest?.('input, select, textarea')) return;
      if (e.key >= '1' && e.key <= '9') {
        this.onIntent({ type: 'select', index: Number(e.key) - 1, ts: e.timeStamp });
        return;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (arrows[e.key]) {
        e.preventDefault();
        this.onIntent({ type: 'nudge', dx: arrows[e.key][0], dy: arrows[e.key][1], ts: e.timeStamp });
        return;
      }
      const type = KEYMAP[e.key];
      if (!type) return;
      if (e.key === ' ') e.preventDefault();
      this.onIntent({ type, pointerType: 'keyboard', ts: e.timeStamp });
    });

    this._on(window, 'keyup', (e) => {
      if (!this.enabled || e.key !== ' ') return;
      this.onIntent({ type: 'release', pointerType: 'keyboard', ts: e.timeStamp });
    });
  }

  dispose() {
    for (const off of this._handlers) off();
    this._handlers = [];
  }
}
