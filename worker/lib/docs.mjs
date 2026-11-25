// worker/lib/docs.mjs — documentos: S3, texto por página, OCR (Textract) e metadados.
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { TextractClient, DetectDocumentTextCommand } from '@aws-sdk/client-textract';
import { PDFDocument } from 'pdf-lib';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import crypto from 'node:crypto';

export const S3_BUCKET = process.env.S3_BUCKET_ANALISE || 'gomjur-br'; // mesmo bucket do jur.js
const REGIOES = { 'gomjur-br': 'sa-east-1', 'gomjur-us': 'us-west-2' };
const s3Cache = new Map();
export function s3(bucket = S3_BUCKET) {
  const region = REGIOES[bucket] || process.env.AWS_REGION || 'sa-east-1';
  if (!s3Cache.has(region)) s3Cache.set(region, new S3Client({ region, endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: !!process.env.S3_ENDPOINT }));
  return s3Cache.get(region);
}
let textract = null;
const tx = () => (textract ||= new TextractClient({ region: process.env.TEXTRACT_REGION || process.env.AWS_REGION || 'us-east-1' }));

export async function baixarS3(bucket, key) {
  const out = await s3(bucket).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const c of out.Body) chunks.push(c);
  return Buffer.concat(chunks);
}

export async function enviarS3(bucket, key, buffer, contentType) {
  await s3(bucket).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
  return { bucket, key };
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// carimbo que o tribunal repete no topo/lateral de cada página (PJe: "Num. … - Pág. N", "Assinado eletronicamente por…";
// e-SAJ: "Este documento é cópia do original…"). Ocupa o começo da página e esconde o conteúdo da classificação.
const LINHA_CARIMBO = [
  /^Num\. ?\d+ - Pág\. ?\d+$/i,
  /^Assinado eletronicamente por:/i,
  /^https?:\/\/\S*(ConsultaDocumento|listView|conferirdocumento|abrirConferencia)\S*$/i,
  /^Número do documento: ?\d+$/i,
  /^Este documento foi gerado pelo usuário/i,
  /^Este documento é cópia do original/i,
  /^Para conferir o original, acesse/i,
];
export const semCarimbo = (texto) => String(texto || '').split('\n')
  .filter((l) => !LINHA_CARIMBO.some((re) => re.test(l.trim()))).join('\n').trim();

const ehPdf = (doc) => /pdf/i.test(doc.mimeType || '') || /\.pdf$/i.test(doc.originalName || '');
const ehImagem = (doc) => /^image\/(png|jpe?g|tiff)/i.test(doc.mimeType || '') || /\.(png|jpe?g|tiff?)$/i.test(doc.originalName || '');
export const ehAudio = (doc) => /^audio\//i.test(doc.mimeType || '') || /\.(mp3|wav|ogg|m4a|opus|aac|wma)$/i.test(doc.originalName || '');
export const suportado = (doc) => ehPdf(doc) || ehImagem(doc) || ehAudio(doc);

async function ocrBytes(bytes) {
  const r = await tx().send(new DetectDocumentTextCommand({ Document: { Bytes: bytes } }));
  return (r.Blocks || []).filter((b) => b.BlockType === 'LINE').map((b) => b.Text).join('\n');
}

// texto por página de um PDF; páginas sem texto (escaneadas) vão para o Textract
async function lerTextoPdf(buf, maxPaginas) {
  const paginas = [];
  let i = 0;
  await pdfParse(buf, {
    max: maxPaginas,
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      let ultimoY = null; let t = '';
      for (const item of tc.items) {
        const y = item.transform?.[5];
        t += (ultimoY !== null && y !== ultimoY ? '\n' : ' ') + item.str;
        ultimoY = y;
      }
      paginas[i++] = t.replace(/[ \t]+/g, ' ').trim();
      return '';
    },
  });
  return paginas;
}

// PDF com tabela xref corrompida ("bad XRef entry", "Invalid XRef stream"...): o pdf-lib reconstrói a estrutura ao regravar
async function repararPdf(buffer) {
  const d = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
  return Buffer.from(await d.save({ useObjectStreams: false }));
}

export async function extrairPaginasPdf(buffer, { maxPaginas = 400, minCharsSemOcr = 40, ocr = true } = {}) {
  let paginas;
  let reparado = false;
  try {
    paginas = await lerTextoPdf(buffer, maxPaginas);
  } catch (e1) {
    // 1) tenta de novo com o PDF reconstruído; 2) sem texto legível, manda todas as páginas para o OCR
    try {
      const fixo = await repararPdf(buffer);
      buffer = fixo;
      reparado = true;
      paginas = await lerTextoPdf(fixo, maxPaginas);
    } catch (e2) {
      if (!reparado) throw new Error(`PDF ilegível (${String(e1.message || e1).slice(0, 120)}); reparo falhou: ${String(e2.message || e2).slice(0, 120)}`);
      const n = (await PDFDocument.load(buffer, { ignoreEncryption: true })).getPageCount();
      paginas = Array.from({ length: Math.min(n, maxPaginas) }, () => '');
    }
  }

  const saida = paginas.map((texto, idx) => ({ pagina: idx + 1, texto: texto || '', ocr: false }));
  // página escaneada do PJe traz só o carimbo como texto: conta o que sobra sem ele
  const precisam = saida.filter((p) => semCarimbo(p.texto).length < minCharsSemOcr);
  if (ocr && precisam.length) {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    for (const p of precisam) {
      try {
        const um = await PDFDocument.create();
        const [pg] = await um.copyPages(src, [p.pagina - 1]);
        um.addPage(pg);
        const bytes = await um.save();
        if (bytes.length > 9.5 * 1024 * 1024) continue; // limite do Textract síncrono
        p.texto = await ocrBytes(bytes);
        p.ocr = true;
      } catch (e) {
        p.erroOcr = String(e.message || e).slice(0, 200);
      }
    }
  }
  return saida;
}

export async function extrairPaginas(doc, buffer, opts) {
  if (ehPdf(doc)) return extrairPaginasPdf(buffer, opts);
  if (ehImagem(doc)) return [{ pagina: 1, texto: await ocrBytes(buffer), ocr: true }];
  return [];
}

// metadados que ajudam a detectar edição (alerta, nunca conclusão)
const EDITORES = /(photoshop|gimp|canva|ilovepdf|smallpdf|sejda|pdfescape|foxit phantom|nitro|word|libreoffice|google docs|pixlr|paint)/i;
export async function metadadosPdf(buffer) {
  try {
    const d = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    const produtor = d.getProducer() || null;
    const criador = d.getCreator() || null;
    const criado = d.getCreationDate() || null;
    const modificado = d.getModificationDate() || null;
    const sinais = [];
    if (EDITORES.test(`${produtor} ${criador}`)) sinais.push(`gerado/editado com ${produtor || criador}`);
    if (criado && modificado && +modificado - +criado > 60 * 1000) sinais.push('arquivo modificado depois de criado');
    return { produtor, criador, criado, modificado, paginas: d.getPageCount(), sinais };
  } catch (e) {
    return { erro: String(e.message || e).slice(0, 200), sinais: [] };
  }
}

/**
 * Monta texto com marcadores [[doc:ID]] e [[p.N]] para a LLM citar a origem.
 * @param {Array<{docId, paginas:[{pagina,texto}]}>} partes
 */
export function textoComMarcadores(partes, limiteChars = 150000) {
  let out = '';
  for (const parte of partes) {
    out += `\n[[doc:${parte.docId}]] ${parte.titulo || ''}\n`;
    for (const p of parte.paginas) {
      const bloco = `[[p.${p.pagina}]]\n${p.texto}\n`;
      if (out.length + bloco.length > limiteChars) return `${out}\n[... texto truncado por limite ...]`;
      out += bloco;
    }
  }
  return out;
}
