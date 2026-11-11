// scripts/seed-pacote.mjs — instala/atualiza um pacote e (opcional) liga a análise para um escritório/cliente.
//
// Só o pacote (global, disponível para qualquer escritório habilitado):
//   node scripts/seed-pacote.mjs pacotes/crefisa-2026.2.json
//
// Pacote + ligar para um escritório e um ou mais clientes (modo assistido, todos os módulos):
//   node scripts/seed-pacote.mjs pacotes/crefisa-2026.2.json --escritorio <id> --cliente <id> [--cliente <id2>] [--modo sombra|assistido|automatico]
//
// Para desligar tudo de um escritório: db.escritorios.updateOne({_id}, {$set:{"funcao.analiseInicial": false}})
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../shared/esteira.js');

const args = process.argv.slice(2);
const arquivo = args[0];
if (!arquivo) { console.error('uso: node scripts/seed-pacote.mjs <pacote.json> [--escritorio id --cliente id ...]'); process.exit(1); }
const pega = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const escritorio = pega('--escritorio')[0];
const clientes = pega('--cliente');
const modo = pega('--modo')[0] || 'assistido';

const pacote = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
delete pacote._comentario;
if (pacote.manualArquivo) {
  const f = path.join(path.dirname(arquivo), pacote.manualArquivo);
  pacote.manualTexto = fs.readFileSync(f, 'utf8');
}

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db(process.env.DB_NAME);
await E.garantirIndices(db);

await db.collection('pacotesAnalise').updateOne(
  { chave: pacote.chave, codigoEscritorio: null },
  { $set: { ...pacote, codigoEscritorio: null, atualizadoEm: new Date() }, $inc: { revisao: 1 } },
  { upsert: true },
);
console.log(`pacote ${pacote.chave} instalado (${pacote.regras.length} regras, ${pacote.taxonomia.teses.length} teses)`);

if (escritorio) {
  const ce = new ObjectId(escritorio);
  await db.collection('escritorios').updateOne({ _id: ce }, { $set: { 'funcao.analiseInicial': true } });
  for (const c of clientes) {
    const cfg = E.mergeConfig({
      ativo: true,
      pacoteChave: pacote.chave,
      ativoDesde: new Date(),
      modulos: Object.fromEntries(E.MODULOS.map((m) => [m, true])),
      revisao: { modo, confiancaMinima: 0.85 },
    });
    await db.collection('analiseConfig').updateOne(
      { codigoEscritorio: ce, clienteId: new ObjectId(c) },
      { $set: { ...cfg, codigoEscritorio: ce, clienteId: new ObjectId(c), atualizadoEm: new Date() }, $setOnInsert: { criadoEm: new Date() } },
      { upsert: true },
    );
    console.log(`análise ligada: escritório ${escritorio}, cliente ${c}, modo ${modo}`);
  }
  console.log('Falta: destinatários (tela de configuração) e caixa de e-mail (POST /analise/caixa-salvar).');
}
await client.close();
