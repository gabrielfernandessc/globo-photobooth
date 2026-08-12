/* ══════════════════════════════════════════════════════════
   PREVIEW — o que o convidado vê no telão enquanto se posiciona

   Substitui o WebRTC. A troca não é gosto: é contagem de peças que
   podem falhar.

   WebRTC precisava de sinalização, ICE, STUN e — em rede de convidado
   com isolamento de cliente — de um TURN para relayar. Três serviços e
   uma negociação, para levar imagem entre dois aparelhos que estão na
   mesma LAN, a metros um do outro.

   Aqui o celular faz POST de quadros JPEG e o telão consome um stream
   MJPEG dentro de uma <img>. O navegador decodifica sozinho: sem
   JavaScript de mídia, sem negociação, sem servidor externo. Se a
   imagem aparece, funcionou; se não aparece, o erro é um HTTP comum.

   O preview é DESCARTÁVEL e vive só em memória. A fotografia não passa
   por aqui — ela sobe em resolução plena por outro caminho.
   ══════════════════════════════════════════════════════════ */

const FRONTEIRA = 'quadro-do-preview';

/**
 * Um barramento de quadros por sessão.
 *
 * Só o último quadro importa: preview atrasado é pior que preview com
 * menos quadros. Nada é enfileirado — quem chegou depois substitui.
 */
function createPreviewHub({ log = () => {} } = {}) {
  const sessoes = new Map();

  function estado(code) {
    if (!sessoes.has(code)) {
      sessoes.set(code, {
        ultimoQuadro: null,
        recebidoEm: 0,
        largura: 0,
        altura: 0,
        quadros: 0,
        assinantes: new Set(),
      });
    }
    return sessoes.get(code);
  }

  /** O celular entregou um quadro. */
  function publicar(code, jpeg, { width = 0, height = 0 } = {}) {
    const s = estado(code);
    s.ultimoQuadro = jpeg;
    s.recebidoEm = Date.now();
    s.largura = width;
    s.altura = height;
    s.quadros++;

    for (const { escrever } of s.assinantes) {
      try {
        escrever(jpeg);
      } catch {
        // Telão fechou no meio do envio; o cleanup do próprio response
        // remove o assinante.
      }
    }
    return s.assinantes.size;
  }

  /**
   * O telão abriu a <img>. Devolve uma função de cancelamento.
   *
   * Um quadro é enviado na hora quando já existe: sem isso a imagem
   * fica em branco até o celular mandar o próximo, e um telão que
   * recarrega parece travado.
   *
   * `encerrar` existe porque um stream MJPEG nunca termina sozinho: ele
   * é uma resposta HTTP que fica aberta para sempre, por definição. Sem
   * uma forma de derrubá-la, `server.close()` espera indefinidamente e
   * o totem não reinicia enquanto houver um telão conectado.
   */
  function assinar(code, escrever, encerrar = () => {}) {
    const s = estado(code);
    const assinante = { escrever, encerrar };
    s.assinantes.add(assinante);
    if (s.ultimoQuadro) escrever(s.ultimoQuadro);
    return () => s.assinantes.delete(assinante);
  }

  function status(code) {
    const s = sessoes.get(code);
    if (!s) return { ativo: false, quadros: 0, assinantes: 0, idadeMs: null };

    return {
      ativo: !!s.ultimoQuadro && Date.now() - s.recebidoEm < 3000,
      quadros: s.quadros,
      assinantes: s.assinantes.size,
      idadeMs: s.recebidoEm ? Date.now() - s.recebidoEm : null,
      largura: s.largura,
      altura: s.altura,
    };
  }

  /** Alguém está de fato olhando? O celular só gasta bateria se sim. */
  function temAudiencia(code) {
    return (sessoes.get(code)?.assinantes.size || 0) > 0;
  }

  function encerrar(code) {
    sessoes.delete(code);
  }

  /**
   * Derruba todos os streams abertos. É o que permite ao servidor
   * desligar: sem isto `server.close()` fica esperando respostas que,
   * por natureza, nunca terminam.
   */
  function encerrarTodos() {
    let fechados = 0;
    for (const s of sessoes.values()) {
      for (const { encerrar: fechar } of s.assinantes) {
        try { fechar(); fechados++; } catch { /* já caiu */ }
      }
      s.assinantes.clear();
    }
    sessoes.clear();
    return fechados;
  }

  return { publicar, assinar, status, temAudiencia, encerrar, encerrarTodos, FRONTEIRA };
}

/**
 * Cabeçalhos do multipart/x-mixed-replace.
 *
 * É o formato que uma <img> entende como stream contínuo. O
 * Cache-Control é obrigatório: sem ele um proxy ou o próprio navegador
 * pode bufferizar e o preview congela num quadro só.
 */
function cabecalhosMjpeg() {
  return {
    'Content-Type': `multipart/x-mixed-replace; boundary=${FRONTEIRA}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    // Sem Connection: close de propósito. Com ele o corpo só termina
    // quando a conexão cai, e o cliente bufferiza tudo esperando o fim —
    // um stream que nunca termina nunca entrega quadro nenhum. Deixando
    // o Node usar chunked, cada quadro sai na hora em que é escrito.
    'X-Accel-Buffering': 'no',
  };
}

/** Um quadro dentro do stream multipart. */
function quadroMjpeg(jpeg) {
  return Buffer.concat([
    Buffer.from(`--${FRONTEIRA}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
    jpeg,
    Buffer.from('\r\n'),
  ]);
}

module.exports = { createPreviewHub, cabecalhosMjpeg, quadroMjpeg, FRONTEIRA };
