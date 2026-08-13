#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════
   CONVERSA → TXT

   O Claude Code guarda cada sessão como JSONL em
   ~/.claude/projects/<projeto>/<sessao>.jsonl — uma linha por evento,
   incluindo cada chamada de ferramenta e cada saída de comando.

   Despejar tudo daria um arquivo ilegível de megabytes. Aqui sai o que
   uma pessoa realmente quer reler: o que foi pedido, o que foi
   respondido, e uma linha por ação executada.

   Uso:
     node scripts/conversa-para-txt.js                  # sessão mais recente
     node scripts/conversa-para-txt.js --tudo           # inclui saída dos comandos
     node scripts/conversa-para-txt.js <arquivo.jsonl>
   ══════════════════════════════════════════════════════════ */

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const detalhado = args.includes('--tudo');
const arquivoPedido = args.find(a => a.endsWith('.jsonl'));

/** Descobre a sessão mais recente do projeto atual. */
function sessaoMaisRecente() {
  // O Claude Code troca barra, ponto E underscore por hífen ao nomear a
  // pasta do projeto — trocar só a barra erra em qualquer caminho que
  // contenha um dos outros dois, como um nome de usuário com ponto.
  const slug = process.cwd().replace(/[/._]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', slug);

  if (!fs.existsSync(dir)) {
    console.error(`Nenhuma sessão encontrada em ${dir}`);
    console.error('Rode a partir da pasta do projeto, ou passe o .jsonl como argumento.');
    process.exit(1);
  }

  const arquivos = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ caminho: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!arquivos.length) {
    console.error(`Nenhum .jsonl em ${dir}`);
    process.exit(1);
  }
  return arquivos[0].caminho;
}

const origem = arquivoPedido || sessaoMaisRecente();

function horario(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** Texto puro de um bloco de conteúdo, ignorando imagens e metadados. */
function textoDe(conteudo) {
  if (typeof conteudo === 'string') return conteudo;
  if (!Array.isArray(conteudo)) return '';
  return conteudo
    .filter(b => b?.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

/** Uma linha descrevendo a ação, em vez do JSON inteiro da chamada. */
function resumoDaFerramenta(bloco) {
  const e = bloco.input || {};
  const nome = bloco.name;

  if (nome === 'Bash') return `$ ${(e.command || '').split('\n')[0].slice(0, 160)}`;
  if (nome === 'Write') return `escreveu ${e.file_path}`;
  if (nome === 'Edit') return `editou ${e.file_path}`;
  if (nome === 'Read') return `leu ${e.file_path}`;
  if (nome === 'TodoWrite' || nome?.startsWith('Task')) return null; // ruído
  if (e.file_path) return `${nome}: ${e.file_path}`;
  if (e.command) return `${nome}: ${String(e.command).slice(0, 120)}`;
  if (e.query) return `${nome}: ${String(e.query).slice(0, 120)}`;
  if (e.url) return `${nome}: ${e.url}`;
  return nome;
}

const linhas = [];
let usuarios = 0;
let respostas = 0;
let acoes = 0;

linhas.push('═'.repeat(70));
linhas.push('GLOBO PHOTO BOOTH — transcrição da sessão');
linhas.push(`origem: ${path.basename(origem)}`);
linhas.push(`gerado: ${horario(new Date().toISOString())}`);
linhas.push('═'.repeat(70));
linhas.push('');

for (const linha of fs.readFileSync(origem, 'utf8').split('\n')) {
  if (!linha.trim()) continue;

  let evento;
  try { evento = JSON.parse(linha); } catch { continue; }

  const msg = evento.message;
  if (!msg) continue;

  if (evento.type === 'user') {
    // Resultados de ferramenta chegam como "user"; não são fala de gente.
    const ehResultado = Array.isArray(msg.content)
      && msg.content.some(b => b?.type === 'tool_result');

    if (ehResultado) {
      if (!detalhado) continue;
      const saida = msg.content
        .filter(b => b.type === 'tool_result')
        .map(b => typeof b.content === 'string' ? b.content : textoDe(b.content))
        .join('\n')
        .trim();
      if (saida) linhas.push(`      ↳ ${saida.slice(0, 1500).replace(/\n/g, '\n        ')}`, '');
      continue;
    }

    const texto = textoDe(msg.content);
    // Lembretes do sistema não são o usuário falando.
    if (!texto || texto.startsWith('<system-reminder>')) continue;

    usuarios++;
    linhas.push('', '─'.repeat(70), `VOCÊ  ·  ${horario(evento.timestamp)}`, '─'.repeat(70), texto, '');
    continue;
  }

  if (evento.type === 'assistant') {
    const texto = textoDe(msg.content);
    if (texto) {
      respostas++;
      linhas.push(`CLAUDE  ·  ${horario(evento.timestamp)}`, '', texto, '');
    }

    for (const bloco of (Array.isArray(msg.content) ? msg.content : [])) {
      if (bloco?.type !== 'tool_use') continue;
      const resumo = resumoDaFerramenta(bloco);
      if (!resumo) continue;
      acoes++;
      linhas.push(`    · ${resumo}`);
    }
  }
}

linhas.push('', '═'.repeat(70));
linhas.push(`${usuarios} mensagens suas · ${respostas} respostas · ${acoes} ações executadas`);
linhas.push('═'.repeat(70));

const destino = path.join(process.cwd(), `conversa-photobooth-${new Date().toISOString().slice(0, 10)}.txt`);
fs.writeFileSync(destino, linhas.join('\n'));

console.log(`  ${destino}`);
console.log(`  ${(fs.statSync(destino).size / 1024).toFixed(0)} KB · ${usuarios} mensagens · ${respostas} respostas · ${acoes} ações`);
if (!detalhado) console.log('  (use --tudo para incluir a saída dos comandos)');
