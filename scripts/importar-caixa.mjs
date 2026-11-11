// scripts/importar-caixa.mjs — copia a caixa de e-mail já cadastrada em escritorios.email para analiseCaixas
// (senha cifrada) e, opcionalmente, grava os destinatários de teste em analiseConfig.
//
//   node scripts/importar-caixa.mjs --escritorio <id>                                  # simulação: só mostra o que gravaria
//   node scripts/importar-caixa.mjs --escritorio <id> --apply
//   node scripts/importar-caixa.mjs --escritorio <id> --apply --teste-para fulano@x.com [--imap-host imap.exemplo.com]
//
// SMTP = escritorios.email (host, port, secure, auth.user/pass, from).
// IMAP = mesmo usuário/senha; host = o do SMTP trocando "smtp." por "imap." (ajuste com --imap-host), porta 993.
// Com --apply conecta no IMAP e marca lastUid = última mensagem da pasta, para o worker NÃO ler o histórico da caixa
// (a caixa é compartilhada com o resto do sistema; só mensagens novas, com o código [GJ-SUB-XXXXX], interessam).
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { ImapFlow } from 'imapflow';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../shared/esteira.js');

const args = process.argv.slice(2);
const pega = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const escritorio = pega('--escritorio');
const testePara = pega('--teste-para');
const imapHostArg = pega('--imap-host');
if (!escritorio) { console.error('uso: node scripts/importar-caixa.mjs --escritorio <id> [--apply] [--teste-para email] [--imap-host host]'); process.exit(1); }

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db(process.env.DB_NAME);
const ce = new ObjectId(escritorio);

const esc = await db.collection('escritorios').findOne({ _id: ce }, { projection: { email: 1 } });
const em = esc?.email;
if (!em?.host || !em?.auth?.user || !em?.auth?.pass) { console.error('escritorios.email incompleto (precisa de host e auth.user/pass).'); process.exit(1); }

const imapHost = imapHostArg || String(em.host).replace(/^smtp\./i, 'imap.');
const de = String(em.from || em.auth.user).replace(/^'([^']*)'/, '"$1"'); // 'Nome' <x@y> → "Nome" <x@y>
const plano = {
  de,
  smtp: { host: em.host, port: Number(em.port || 465), secure: em.secure !== false, user: em.auth.user },
  imap: { host: imapHost, port: 993, secure: true, user: em.auth.user, pasta: 'INBOX' },
};
console.log(APPLY ? '*** APLICANDO ***' : '*** SIMULAÇÃO (nada será gravado) ***');
console.log(JSON.stringify(plano, null, 2));
if (testePara) console.log('destinatários de teste (Para de subsídio, acordo e complemento):', testePara);

if (APPLY) {
  // última mensagem existente: o worker só lê o que chegar depois
  const imap = new ImapFlow({ host: plano.imap.host, port: 993, secure: true, auth: { user: em.auth.user, pass: em.auth.pass }, logger: false });
  await imap.connect();
  const box = await imap.mailboxOpen('INBOX', { readOnly: true });
  const lastUid = Number(box.uidNext || 1) - 1;
  await imap.logout();
  console.log(`IMAP ok (${plano.imap.host}); lastUid inicial = ${lastUid}`);

  await db.collection('analiseCaixas').updateOne({ codigoEscritorio: ce }, {
    $set: {
      codigoEscritorio: ce, nome: 'Subsídios', ativo: true, atualizadoEm: new Date(), de: plano.de,
      smtp: { ...plano.smtp, pass: E.cifrar(em.auth.pass) },
      imap: { ...plano.imap, pass: E.cifrar(em.auth.pass) },
    },
    $max: { lastUid },
  }, { upsert: true });
  console.log('analiseCaixas gravada (senha cifrada).');

  if (testePara) {
    const l = { para: [testePara], cc: [] };
    const r = await db.collection('analiseConfig').updateMany({ codigoEscritorio: ce }, { $set: { 'destinatarios.subsidio': l, 'destinatarios.acordo': l, 'destinatarios.complemento': l } });
    console.log('analiseConfig atualizados:', r.modifiedCount);
  }
}
await client.close();
