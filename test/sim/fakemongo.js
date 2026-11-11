// Mongo em memória (só o necessário para simular a esteira). NÃO é usado em produção.
'use strict';
const crypto = require('node:crypto');

let contador = 0;
class ObjectId {
  constructor(hex) {
    if (hex instanceof ObjectId) hex = hex.hex;
    if (hex && typeof hex === 'object' && typeof hex.toHexString === 'function') hex = hex.toHexString();
    this.hex = hex ? String(hex) : (Math.floor(Date.now() / 1000).toString(16) + crypto.randomBytes(5).toString('hex') + (++contador).toString(16).padStart(6, '0')).slice(0, 24);
    if (!/^[0-9a-f]{24}$/i.test(this.hex)) throw new Error(`ObjectId inválido: ${hex}`);
  }
  toHexString() { return this.hex; }
  toString() { return this.hex; }
  toJSON() { return this.hex; }
  equals(o) { return !!o && String(o.toHexString ? o.toHexString() : o) === this.hex; }
  static isValid(v) { return /^[0-9a-f]{24}$/i.test(String(v?.toHexString ? v.toHexString() : v)); }
}

const clone = (v) => {
  if (v instanceof ObjectId) return new ObjectId(v.hex);
  if (v instanceof Date) return new Date(v.getTime());
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = clone(x); return o; }
  return v;
};
const prim = (v) => (v instanceof ObjectId ? `oid:${v.hex}` : v instanceof Date ? v.getTime() : v);
const igual = (a, b) => { const x = prim(a), y = prim(b); if (x === y) return true; if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b); return false; };

function valores(doc, caminho) {
  // devolve todos os valores alcançáveis pelo caminho (expande arrays)
  const partes = caminho.split('.');
  let atuais = [doc];
  for (const p of partes) {
    const prox = [];
    for (const a of atuais) {
      if (a == null) continue;
      if (Array.isArray(a) && !/^\d+$/.test(p)) { for (const el of a) if (el != null && typeof el === 'object') prox.push(el[p]); }
      else prox.push(a[p]);
    }
    atuais = prox;
  }
  return atuais;
}

function condOk(vals, cond) {
  const flat = vals.flatMap((v) => (Array.isArray(v) ? [v, ...v] : [v]));
  const ehOp = cond && typeof cond === 'object' && !(cond instanceof ObjectId) && !(cond instanceof Date) && !Array.isArray(cond) && Object.keys(cond).some((k) => k.startsWith('$'));
  if (!ehOp) return flat.some((v) => igual(v, cond)) || (cond === null && vals.every((v) => v == null));
  return Object.entries(cond).every(([op, arg]) => {
    switch (op) {
      case '$eq': return flat.some((v) => igual(v, arg));
      case '$ne': return !flat.some((v) => igual(v, arg));
      case '$in': return arg.some((a) => flat.some((v) => igual(v, a)) || (a === null && vals.every((v) => v == null)));
      case '$nin': return !arg.some((a) => flat.some((v) => igual(v, a)));
      case '$exists': return arg ? vals.some((v) => v !== undefined) : vals.every((v) => v === undefined);
      case '$gt': return flat.some((v) => v != null && prim(v) > prim(arg));
      case '$gte': return flat.some((v) => v != null && prim(v) >= prim(arg));
      case '$lt': return flat.some((v) => v != null && prim(v) < prim(arg));
      case '$lte': return flat.some((v) => v != null && prim(v) <= prim(arg));
      default: throw new Error(`fakemongo: operador ${op} não suportado`);
    }
  });
}

function bate(doc, q) {
  if (!q) return true;
  return Object.entries(q).every(([k, c]) => {
    if (k === '$or') return c.some((s) => bate(doc, s));
    if (k === '$and') return c.every((s) => bate(doc, s));
    if (k === '$expr') {
      const [op, [a, b]] = Object.entries(c)[0];
      const ev = (x) => (typeof x === 'string' && x.startsWith('$') ? valores(doc, x.slice(1))[0] : x);
      if (op === '$lt') return ev(a) < ev(b);
      throw new Error(`fakemongo: $expr ${op}`);
    }
    return condOk(valores(doc, k), c);
  });
}

function setCaminho(doc, caminho, valor, posicional) {
  const partes = caminho.split('.');
  let o = doc;
  for (let i = 0; i < partes.length - 1; i++) {
    let p = partes[i];
    if (p === '$') p = posicional;
    if (o[p] == null) o[p] = /^\d+$/.test(partes[i + 1]) || partes[i + 1] === '$' ? [] : {};
    o = o[p];
  }
  let ult = partes.at(-1);
  if (ult === '$') ult = posicional;
  o[ult] = valor;
}
function getCaminho(doc, caminho, posicional) {
  return caminho.split('.').reduce((o, p) => (o == null ? o : o[p === '$' ? posicional : p]), doc);
}

function posicionalDe(doc, q) {
  for (const [k, c] of Object.entries(q || {})) {
    const partes = k.split('.');
    if (partes.length < 2) continue;
    const arr = doc[partes[0]];
    if (!Array.isArray(arr)) continue;
    const resto = partes.slice(1).join('.');
    const idx = arr.findIndex((el) => condOk(valores(el, resto), c));
    if (idx >= 0) return idx;
  }
  return 0;
}

function aplicar(doc, upd, q, inserindo) {
  const pos = posicionalDe(doc, q);
  for (const [op, campos] of Object.entries(upd)) {
    for (const [k, v] of Object.entries(campos)) {
      const atual = getCaminho(doc, k, pos);
      switch (op) {
        case '$set': setCaminho(doc, k, clone(v), pos); break;
        case '$setOnInsert': if (inserindo) setCaminho(doc, k, clone(v), pos); break;
        case '$unset': setCaminho(doc, k, undefined, pos); break;
        case '$inc': setCaminho(doc, k, (atual || 0) + v, pos); break;
        case '$min': if (atual === undefined || prim(v) < prim(atual)) setCaminho(doc, k, clone(v), pos); break;
        case '$max': if (atual === undefined || prim(v) > prim(atual)) setCaminho(doc, k, clone(v), pos); break;
        case '$push': {
          const arr = Array.isArray(atual) ? atual : [];
          if (v && typeof v === 'object' && '$each' in v) { arr.push(...clone(v.$each)); if (v.$slice) arr.splice(0, Math.max(0, arr.length + v.$slice)); } else arr.push(clone(v));
          setCaminho(doc, k, arr, pos); break;
        }
        case '$addToSet': {
          const arr = Array.isArray(atual) ? atual : [];
          const itens = v && typeof v === 'object' && '$each' in v ? v.$each : [v];
          for (const it of itens) if (!arr.some((x) => igual(x, it))) arr.push(clone(it));
          setCaminho(doc, k, arr, pos); break;
        }
        default: throw new Error(`fakemongo: update ${op}`);
      }
    }
  }
}

function ordenar(arr, sort) {
  if (!sort) return arr;
  const chaves = Object.entries(sort);
  return arr.slice().sort((a, b) => {
    for (const [k, d] of chaves) {
      const x = prim(valores(a, k)[0]), y = prim(valores(b, k)[0]);
      if (x === y) continue;
      if (x === undefined || x === null) return 1 * d;
      if (y === undefined || y === null) return -1 * d;
      return (x < y ? -1 : 1) * d;
    }
    return 0;
  });
}

class Cursor {
  constructor(itens) { this.itens = itens; }
  sort(s) { this.itens = ordenar(this.itens, s); return this; }
  limit(n) { this.itens = this.itens.slice(0, n); return this; }
  project() { return this; }
  async toArray() { return this.itens.map(clone); }
}

class Colecao {
  constructor(nome) { this.nome = nome; this.docs = []; this.unicos = []; }
  checarUnico(doc, ignorar) {
    for (const u of this.unicos) {
      if (u.parcial && !bate(doc, u.parcial)) continue;
      const chave = (d) => Object.keys(u.spec).map((k) => JSON.stringify(prim(valores(d, k)[0]) ?? null)).join('|');
      const c = chave(doc);
      if (this.docs.some((d) => d !== ignorar && (!u.parcial || bate(d, u.parcial)) && chave(d) === c)) {
        throw Object.assign(new Error(`E11000 duplicate key ${this.nome} ${c}`), { code: 11000 });
      }
    }
  }
  async createIndex(spec, opts = {}) { if (opts.unique) this.unicos.push({ spec, parcial: opts.partialFilterExpression || null }); return 'ok'; }
  find(q = {}) { return new Cursor(this.docs.filter((d) => bate(d, q))); }
  async findOne(q = {}, opts = {}) { const r = ordenar(this.docs.filter((d) => bate(d, q)), opts.sort)[0]; return r ? clone(r) : null; }
  async countDocuments(q = {}) { return this.docs.filter((d) => bate(d, q)).length; }
  async insertOne(doc) { const d = clone(doc); if (!d._id) d._id = new ObjectId(); this.checarUnico(d); this.docs.push(d); return { insertedId: d._id }; }
  async insertMany(arr) { const ids = []; for (const x of arr) ids.push((await this.insertOne(x)).insertedId); return { insertedIds: ids }; }
  async deleteMany(q) { const antes = this.docs.length; this.docs = this.docs.filter((d) => !bate(d, q)); return { deletedCount: antes - this.docs.length }; }
  async updateOne(q, upd, opts = {}) {
    const d = this.docs.find((x) => bate(x, q));
    if (d) { const copia = clone(d); aplicar(copia, upd, q, false); this.checarUnico(copia, d); Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, copia); return { matchedCount: 1, modifiedCount: 1 }; }
    if (opts.upsert) {
      const novo = {};
      for (const [k, v] of Object.entries(q)) if (!k.startsWith('$') && (typeof v !== 'object' || v instanceof ObjectId || v instanceof Date || v === null)) setCaminho(novo, k, clone(v));
      aplicar(novo, upd, q, true);
      if (!novo._id) novo._id = new ObjectId();
      this.checarUnico(novo);
      this.docs.push(novo);
      return { matchedCount: 0, upsertedId: novo._id };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async updateMany(q, upd) { let n = 0; for (const d of this.docs.filter((x) => bate(x, q))) { aplicar(d, upd, q, false); n++; } return { modifiedCount: n }; }
  async findOneAndUpdate(q, upd, opts = {}) {
    const d = ordenar(this.docs.filter((x) => bate(x, q)), opts.sort)[0];
    if (!d) return null;
    const antes = clone(d);
    aplicar(d, upd, q, false);
    return opts.returnDocument === 'after' ? clone(d) : antes;
  }
  aggregate() { return { toArray: async () => [] }; }
}

class Db {
  constructor() { this.cols = new Map(); }
  collection(n) { if (!this.cols.has(n)) this.cols.set(n, new Colecao(n)); return this.cols.get(n); }
}

class MongoClient {
  constructor() { this._db = global.__FAKE_DB || (global.__FAKE_DB = new Db()); }
  async connect() { return this; }
  db() { return this._db; }
  async close() {}
}

module.exports = { ObjectId, MongoClient, Db };
