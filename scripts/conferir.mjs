#!/usr/bin/env node
// Confere peças .docx e .pdf pela linha de comando (arquivos ou pastas).
//
//   node scripts/conferir.mjs peca.docx                      # relatório no terminal
//   node scripts/conferir.mjs ./pecas --csv conferencia.csv  # pasta inteira + planilha
//   node scripts/conferir.mjs peca.docx --anotar ./saida     # gera cópia com comentários do Word
//   node scripts/conferir.mjs peca.docx --modo rascunho      # realce vira alerta, não bloqueio
//   node scripts/conferir.mjs peca.docx --pacote pacotes/crefisa-2026.2.json --dados dados.json
//
// dados.json (opcional): { numeroProcesso, parteAdversa, empresaPolo, cnpjPolo, cnpjsGrupo[], contratos[], pedidos[] }
// Sai com código 1 se alguma peça tiver bloqueio (útil em rotina automática).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../shared/conferencia.js');

const args = process.argv.slice(2);
const opt = (nome) => { const i = args.indexOf(`--${nome}`); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (nome) => { const i = args.indexOf(`--${nome}`); if (i < 0) return false; args.splice(i, 1); return true; };

const modo = opt('modo') || 'protocolo';
const csv = opt('csv');
const anotar = opt('anotar');
const pacoteArq = opt('pacote');
const dadosArq = opt('dados');
const json = flag('json');
if (!args.length) { console.error('uso: node scripts/conferir.mjs <arquivo.docx|arquivo.pdf|pasta> [...] [--modo protocolo|rascunho] [--csv saida.csv] [--anotar pasta] [--pacote pacote.json] [--dados dados.json] [--json]'); process.exit(2); }

const pacote = pacoteArq ? JSON.parse(fs.readFileSync(pacoteArq, 'utf8')) : null;
const dados = dadosArq ? JSON.parse(fs.readFileSync(dadosArq, 'utf8')) : null;
const config = pacote?.conferencia || {};

const arquivos = [];
for (const a of args) {
  const st = fs.statSync(a);
  if (st.isDirectory()) for (const f of fs.readdirSync(a).sort()) { if (/\.(docx|pdf)$/i.test(f) && !f.startsWith('~$')) arquivos.push(path.join(a, f)); }
  else arquivos.push(a);
}
if (anotar) fs.mkdirSync(anotar, { recursive: true });

const linhasCsv = [['arquivo', 'situacao', 'severidade', 'regra', 'local', 'mensagem', 'trecho']];
const resultados = [];
let bloqueadas = 0;
for (const arq of arquivos) {
  const nome = path.basename(arq);
  try {
    const buf = fs.readFileSync(arq);
    const r = await C.conferirArquivo(buf, { modo, config, dados });
    if (!r.ok) bloqueadas++;
    resultados.push({ arquivo: nome, ...r });
    if (!json) console.log(`${C.relatorioTexto(r, nome)}\n`);
    for (const a of r.achados) linhasCsv.push([nome, r.ok ? 'OK' : 'BLOQUEADA', a.severidade, C.NOMES_REGRA[a.regra] || a.regra, C.descreverLocal(a.local), a.mensagem, a.trecho || a.valor || '']);
    if (!r.achados.length) linhasCsv.push([nome, 'OK', '', '', '', 'Nada encontrado', '']);
    if (anotar && r.achados.length && r.formato === 'docx') {
      const out = path.join(anotar, nome.replace(/\.docx$/i, ' - CONFERENCIA.docx'));
      fs.writeFileSync(out, await C.anotarDocx(buf, r.achados));
    }
  } catch (e) {
    bloqueadas++;
    resultados.push({ arquivo: nome, erro: e.message });
    console.error(`ERRO ${nome}: ${e.message}`);
    linhasCsv.push([nome, 'ERRO', '', '', '', e.message, '']);
  }
}

if (json) console.log(JSON.stringify(resultados, null, 2));
else console.log(`${arquivos.length} peça(s) conferida(s), ${bloqueadas} com bloqueio.`);
if (csv) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/\s+/g, ' ')}"`;
  fs.writeFileSync(csv, `﻿${linhasCsv.map((l) => l.map(q).join(';')).join('\r\n')}\r\n`);
  console.log(`Planilha: ${csv}`);
}
process.exit(bloqueadas ? 1 : 0);
