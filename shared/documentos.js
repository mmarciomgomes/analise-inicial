// shared/documentos.js — quais documentos do processo entram na leitura da inicial.
// O processo costuma ter também contestação, formulários, recibos, cópias para protocolo etc.; ler tudo custa OCR/LLM e polui a análise.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// pastas do sistema que guardam peças do próprio escritório (não fazem parte da inicial)
const PASTAS_EXCLUIDAS = new Set(['FORMULARIOS', 'DOC_CONT', 'RECIBOS', 'SUBSIDIOS', 'ANALISE', 'CALCULOS', 'PETICOES']);
const NOME_EXCLUIDO = /contesta|recibo|formul[aá]rio|procura[cç][aã]o|atos[ _-]*constitutivos|subs[ií]dio|\.(zip|rar|txt)$/i;

// devolve o motivo de ficar de fora por padrão, ou null quando é candidato a fazer parte da inicial
function motivoExclusao(doc) {
  if (['subsidio', 'analise-minuta'].includes(doc?.origem)) return 'documento gerado/recebido pela própria análise';
  const pastas = (doc?.folderPathSegments || []).map(norm);
  const pasta = pastas.find((p) => PASTAS_EXCLUIDAS.has(p));
  if (pasta) return `pasta ${pasta}`;
  if (NOME_EXCLUIDO.test(String(doc?.originalName || ''))) return 'nome indica contestação, recibo, formulário, procuração, subsídio ou arquivo compactado/texto';
  return null;
}

module.exports = { motivoExclusao, PASTAS_EXCLUIDAS };
