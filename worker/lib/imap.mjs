// worker/lib/imap.mjs — lê a caixa de subsídios, vincula respostas pelo código [GJ-SUB-XXXXX] (ou In-Reply-To)
// e grava os anexos no S3 + documentosAnexados (origem "subsidio").
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import JSZip from 'jszip';
import { enviarS3, S3_BUCKET } from './docs.mjs';
import { E } from './contexto.mjs';

const RE_CODIGO = /\[?(GJ-SUB-[A-Z0-9]{5})\]?/i;

const limparNome = (n) => String(n || 'anexo').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 150);

async function expandirAnexos(anexos) {
  const out = [];
  for (const a of anexos) {
    const nome = a.filename || 'anexo';
    if (/\.zip$/i.test(nome) || /zip/i.test(a.contentType || '')) {
      try {
        const zip = await JSZip.loadAsync(a.content);
        for (const f of Object.values(zip.files)) {
          if (f.dir || /__MACOSX|\.DS_Store/.test(f.name)) continue;
          out.push({ filename: f.name.split('/').pop(), contentType: null, content: await f.async('nodebuffer') });
        }
        continue;
      } catch { /* zip inválido: guarda como veio */ }
    }
    out.push(a);
  }
  return out;
}

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', opus: 'audio/ogg', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const mimeDe = (nome, ct) => ct || MIME[String(nome).split('.').pop().toLowerCase()] || 'application/octet-stream';

export async function lerCaixa(db, caixa, log) {
  const client = new ImapFlow({
    host: caixa.imap.host, port: Number(caixa.imap.port || 993), secure: caixa.imap.secure !== false,
    auth: { user: caixa.imap.user, pass: caixa.imap.pass }, logger: false,
  });
  await client.connect();
  let processadas = 0;
  const lock = await client.getMailboxLock(caixa.imap.pasta || 'INBOX');
  try {
    const desde = Number(caixa.lastUid || 0);
    for await (const msg of client.fetch({ uid: `${desde + 1}:*` }, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= desde) continue;
      const ja = await db.collection('analiseEmailsRecebidos').findOne({ caixaId: caixa._id, uid: msg.uid });
      if (ja) continue;
      const mail = await simpleParser(msg.source);
      const assunto = mail.subject || '';
      const m = assunto.match(RE_CODIGO);
      let sol = m ? await db.collection('subsidiosSolicitacoes').findOne({ codigo: m[1].toUpperCase(), codigoEscritorio: caixa.codigoEscritorio }) : null;
      if (!sol && mail.inReplyTo) sol = await db.collection('subsidiosSolicitacoes').findOne({ messageId: mail.inReplyTo, codigoEscritorio: caixa.codigoEscritorio });

      const registro = {
        caixaId: caixa._id, codigoEscritorio: caixa.codigoEscritorio, uid: msg.uid, de: mail.from?.text || null, assunto,
        data: mail.date || new Date(), solicitacaoId: sol?._id || null, status: sol ? 'vinculado' : 'sem_vinculo', anexos: [], criadoEm: new Date(),
      };
      if (sol) {
        const anexos = await expandirAnexos((mail.attachments || []).filter((a) => a.contentDisposition !== 'inline' || /pdf|zip|audio/i.test(a.contentType || '')));
        const docIds = [];
        for (const a of anexos) {
          const nome = limparNome(a.filename);
          const key = `${caixa.codigoEscritorio.toHexString()}/analise/${sol.idProcesso.toHexString()}/subsidios/${msg.uid}-${nome}`;
          const tipo = mimeDe(nome, a.contentType);
          await enviarS3(S3_BUCKET, key, a.content, tipo);
          const proc = await db.collection('processos').findOne({ _id: sol.idProcesso }, { projection: { numeroProcesso: 1 } });
          const ins = await db.collection('documentosAnexados').insertOne({
            idProcesso: sol.idProcesso, codigoEscritorio: caixa.codigoEscritorio, numeroProcesso: proc?.numeroProcesso || null,
            folderId: null, folderPathSegments: [], descricao: `Subsídio recebido por e-mail (${sol.codigo})`,
            s3Key: key, storedName: key, originalName: nome, mimeType: tipo, size: a.content.length, bucket: S3_BUCKET,
            origem: 'subsidio', subsidioCodigo: sol.codigo, cadastradoEm: new Date(), uploadedAt: new Date(), criadoPor: 'analise-imap',
          });
          docIds.push(ins.insertedId);
          registro.anexos.push({ nome, docId: ins.insertedId });
        }
        await db.collection('subsidiosSolicitacoes').updateOne({ _id: sol._id }, { $push: { eventos: { tipo: 'resposta', em: new Date(), de: registro.de, anexos: docIds.length } } });
        if (docIds.length) {
          await E.enfileirar(db, { codigoEscritorio: caixa.codigoEscritorio, idProcesso: sol.idProcesso, etapa: 'subsidios', payload: { acao: 'recebido', solicitacaoId: String(sol._id), docIds: docIds.map(String) }, prioridade: 2, chave: `subsidios:recebido:${caixa._id}:${msg.uid}` });
        }
      }
      await db.collection('analiseEmailsRecebidos').insertOne(registro);
      await db.collection('analiseCaixas').updateOne({ _id: caixa._id }, { $max: { lastUid: msg.uid } });
      processadas++;
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  if (processadas) log(`IMAP ${caixa.imap.user}: ${processadas} mensagem(ns)`);
  return processadas;
}
