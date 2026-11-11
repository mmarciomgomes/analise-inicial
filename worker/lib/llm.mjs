// worker/lib/llm.mjs — chamada de LLM com saída estruturada (tool forçada) + validação Ajv.
// Mesmo padrão do prazo.mjs (Responses API com function tool; fallback para chat.completions).
import OpenAI from 'openai';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
const cacheValidadores = new Map();

const MODEL = process.env.ANALISE_LLM_MODEL || process.env.LLM_MODEL || 'gpt-6.1-sol';
const TIMEOUT_MS = Number(process.env.ANALISE_LLM_TIMEOUT_MS || 180000);
const EFFORT = String(process.env.ANALISE_LLM_REASONING || 'medium');
const DISABLED = String(process.env.ANALISE_LLM_DISABLED || '') === '1';

let client = null;
function openai() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: TIMEOUT_MS, maxRetries: 2 });
  return client;
}

// semáforo simples de concorrência
const MAX_CONC = Math.max(1, Number(process.env.ANALISE_LLM_CONCURRENCY || 3));
let ativos = 0;
const fila = [];
async function sem(fn) {
  if (ativos >= MAX_CONC) await new Promise((r) => fila.push(r));
  ativos++;
  try { return await fn(); } finally { ativos--; const n = fila.shift(); if (n) n(); }
}

function validador(schema) {
  const k = JSON.stringify(schema);
  if (!cacheValidadores.has(k)) cacheValidadores.set(k, ajv.compile(schema));
  return cacheValidadores.get(k);
}

/**
 * Chama a LLM obrigando o uso de uma "tool" cujo parâmetro é o JSON de saída.
 * Se a saída não validar, tenta 1 vez de novo mostrando os erros.
 * @returns {Promise<{dados:any, uso:object, modelo:string, tentativas:number}>}
 */
export async function chamarEstruturado({ sistema, usuario, nome, descricao, schema, modelo = MODEL, esforco = EFFORT, registrarUso }) {
  if (DISABLED) throw new Error('LLM desabilitada (ANALISE_LLM_DISABLED=1)');
  const validar = validador(schema);
  let ultimoErro = null;
  let uso = null;

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const msgUsuario = ultimoErro
      ? `${usuario}\n\n---\nSua resposta anterior não passou na validação do formato:\n${ultimoErro}\nResponda de novo chamando a ferramenta ${nome} com o JSON corrigido.`
      : usuario;

    let args = null;
    if (typeof openai().responses?.create === 'function') {
      const req = {
        model: modelo,
        instructions: sistema,
        input: [{ role: 'user', content: msgUsuario }],
        tools: [{ type: 'function', name: nome, description: descricao, parameters: schema, strict: false }],
        tool_choice: { type: 'function', name: nome },
      };
      if (esforco && esforco !== 'none') req.reasoning = { effort: esforco };
      const resp = await sem(() => openai().responses.create(req));
      const fc = (resp?.output || []).find((o) => o?.type === 'function_call');
      args = fc?.arguments || null;
      uso = resp?.usage ? { entrada: resp.usage.input_tokens, saida: resp.usage.output_tokens } : null;
    } else {
      const resp = await sem(() => openai().chat.completions.create({
        model: modelo,
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: msgUsuario }],
        tools: [{ type: 'function', function: { name: nome, description: descricao, parameters: schema } }],
        tool_choice: { type: 'function', function: { name: nome } },
      }));
      args = resp?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments || null;
      uso = resp?.usage ? { entrada: resp.usage.prompt_tokens, saida: resp.usage.completion_tokens } : null;
    }
    if (registrarUso && uso) await registrarUso({ ...uso, modelo, nome }).catch(() => {});

    if (!args) { ultimoErro = 'Nenhuma chamada de ferramenta retornada.'; continue; }
    let dados;
    try { dados = JSON.parse(args); } catch (e) { ultimoErro = `JSON inválido: ${e.message}`; continue; }
    if (validar(dados)) return { dados, uso, modelo, tentativas: tentativa };
    ultimoErro = ajv.errorsText(validar.errors, { separator: '\n' }).slice(0, 3000);
  }
  throw new Error(`LLM (${nome}) não retornou formato válido: ${ultimoErro}`);
}

/** Transcrição de áudio (gravação Toscana). */
export async function transcrever({ buffer, nomeArquivo, modelo = process.env.ANALISE_TRANSCRICAO_MODEL || 'gpt-4o-transcribe' }) {
  if (DISABLED) throw new Error('LLM desabilitada');
  const { toFile } = await import('openai');
  const file = await toFile(buffer, nomeArquivo || 'audio.mp3');
  const r = await sem(() => openai().audio.transcriptions.create({ file, model: modelo, language: 'pt' }));
  return r?.text || '';
}

export const LLM_MODEL = MODEL;
