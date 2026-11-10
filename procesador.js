// AudioWorklet de la plataforma: instancia nucleo.wasm (el núcleo C++) y procesa bloques de 128 muestras.
// Mensajes que recibe:  {tipo:"compilar", bytes:Uint8Array} · {tipo:"param", i, v} · {tipo:"reiniciar"} · {tipo:"activo", v}
// Mensajes que envía:   {tipo:"listo"} · {tipo:"compilado", ok} · {tipo:"datos", canales:[Float32Array…]} cada 1024 muestras
// (canal 0 = salida izquierda; luego una por cada «ver»). AudioWorkletGlobalScope no tiene TextEncoder: el hilo principal
// manda el programa ya codificado en UTF-8.
const VENTANA = 2048, CADA = 1024;

class ProcesadorOnda extends AudioWorkletProcessor {
  constructor(opciones) {
    super();
    this.listo = false;
    this.activo = false;
    this.cola = [];
    this.anillos = [];
    this.pos = 0;
    this.desde = 0;
    this.sondas = 0;
    const vacio = () => 0;
    WebAssembly.instantiate(opciones.processorOptions.wasm, { wasi_snapshot_preview1: { fd_close: vacio, fd_seek: vacio, fd_write: vacio } }).then(({ instance }) => {
      this.ex = instance.exports;
      this.ex._initialize();
      this.h = this.ex.ad_crear(sampleRate);
      this.listo = true;
      this.port.postMessage({ tipo: "listo" });
      for (const m of this.cola) this.mensaje(m);
      this.cola = [];
    });
    this.port.onmessage = (e) => (this.listo ? this.mensaje(e.data) : this.cola.push(e.data));
  }

  mensaje(m) {
    const ex = this.ex;
    if (m.tipo === "compilar") {
      const p = ex.ad_reservar(m.bytes.length + 1);
      const mem = new Uint8Array(ex.memory.buffer, p, m.bytes.length + 1);
      mem.set(m.bytes);
      mem[m.bytes.length] = 0;
      const ok = ex.ad_compilar(this.h, p, m.bytes.length) === 1;
      ex.ad_liberar(p);
      if (ok && m.valores) for (const [i, v] of m.valores) ex.ad_fijar_param(this.h, i, v);
      if (ok && m.reiniciar) ex.ad_reiniciar(this.h);
      this.sondas = ok ? ex.ad_num_sondas(this.h) : 0;
      this.anillos = Array.from({ length: 1 + this.sondas }, () => new Float32Array(VENTANA));
      this.pos = 0;
      this.desde = 0;
      this.port.postMessage({ tipo: "compilado", ok });
    } else if (m.tipo === "param") ex.ad_fijar_param(this.h, m.i, m.v);
    else if (m.tipo === "reiniciar") ex.ad_reiniciar(this.h);
    else if (m.tipo === "activo") this.activo = m.v;
  }

  process(_entradas, salidas) {
    const out = salidas[0];
    const n = out[0].length;
    if (!this.listo || !this.activo) {
      for (const c of out) c.fill(0);
      return true;
    }
    const ex = this.ex;
    ex.ad_procesar(this.h, n);
    const mem = ex.memory.buffer;  // se vuelve a leer: la memoria puede crecer
    const L = new Float32Array(mem, ex.ad_salida(this.h, 0), n);
    out[0].set(L);
    if (out[1]) out[1].set(new Float32Array(mem, ex.ad_salida(this.h, 1), n));
    // anillos para el osciloscopio y el espectro
    const fuentes = [L];
    for (let k = 0; k < this.sondas; k++) fuentes.push(new Float32Array(mem, ex.ad_sonda(this.h, k), n));
    for (let k = 0; k < fuentes.length; k++) {
      const a = this.anillos[k], f = fuentes[k];
      for (let j = 0; j < n; j++) a[(this.pos + j) % VENTANA] = f[j];
    }
    this.pos = (this.pos + n) % VENTANA;
    this.desde += n;
    if (this.desde >= CADA) {
      this.desde = 0;
      const canales = this.anillos.map((a) => {
        const c = new Float32Array(VENTANA);
        c.set(a.subarray(this.pos));
        c.set(a.subarray(0, this.pos), VENTANA - this.pos);
        return c;
      });
      this.port.postMessage({ tipo: "datos", canales }, canales.map((c) => c.buffer));
    }
    return true;
  }
}

registerProcessor("onda", ProcesadorOnda);
