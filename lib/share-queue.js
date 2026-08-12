/* ══════════════════════════════════════════════════════════
   FILA DE PUBLICAÇÃO

   Regra única e inegociável: a foto já está pronta e salva antes de
   qualquer coisa aqui acontecer. Esta fila só decide QUANDO ela vai
   para a internet — nunca SE ela existe.

   Por isso nada aqui bloqueia a captura, e uma falha de publicação
   jamais vira "falha ao tirar foto" na tela. São eventos diferentes e o
   convidado precisa ver a diferença.

   O estado mora no SQLite, então a fila atravessa um restart do
   servidor — que é justamente o momento em que a internet costuma estar
   caída.
   ══════════════════════════════════════════════════════════ */

const { SHARE } = require('./db');
const { config } = require('./config');

/**
 * Espera crescente entre tentativas, com um teto.
 *
 * Sem teto, a oitava tentativa cairia em horas e a foto só publicaria
 * depois de o evento acabar. Com teto, a fila continua batendo de
 * minuto em minuto até a internet voltar.
 */
function backoffMs(attempts) {
  const { retryBaseMs, retryMaxMs } = config.cloud;
  return Math.min(retryBaseMs * 2 ** Math.max(0, attempts - 1), retryMaxMs);
}

function createShareQueue({ repo, storage, publisher, log = () => {} }) {
  let timer = null;
  let running = false;
  let lastError = null;
  let lastPublishedAt = null;
  const listeners = new Set();

  function announce(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log('warn', 'ouvinte da fila falhou', { error: err.message });
      }
    }
  }

  async function publishOne(job) {
    const { photoId, attempts } = job;

    // Os bytes saem do disco na hora de publicar, e não ficam guardados
    // na fila: uma fila de 50 fotos não pode virar 1 GB de RAM.
    const master = await storage.get(job.keys.final);
    const web = job.keys.web ? await storage.get(job.keys.web).catch(() => null) : null;

    const result = await publisher.publish({ photoId, id: photoId, master, web });

    if (result?.skipped) {
      // Sem nuvem configurada não é falha: o trabalho sai da fila e o
      // totem segue sendo um totem de LAN.
      repo.markShare(photoId, SHARE.SKIPPED, { attempts });
      announce({ photoId, status: SHARE.SKIPPED });
      return;
    }

    repo.markShare(photoId, SHARE.PUBLISHED, { attempts: attempts + 1 });
    repo.setPublicUrl(photoId, result.publicUrl);
    lastPublishedAt = Date.now();
    lastError = null;

    log('info', 'foto publicada', { captureId: photoId, publicUrl: result.publicUrl });
    announce({ photoId, status: SHARE.PUBLISHED, publicUrl: result.publicUrl });
  }

  function handleFailure(job, err) {
    const attempts = job.attempts + 1;
    const permanente = err?.transient === false;
    const esgotou = attempts >= config.cloud.maxAttempts;

    lastError = err.message;

    if (permanente || esgotou) {
      repo.markShare(job.photoId, SHARE.FAILED, { attempts, error: err.message });
      log('error', permanente ? 'publicação recusada em definitivo' : 'publicação desistiu após esgotar tentativas', {
        captureId: job.photoId,
        attempts,
        error: err.message,
      });
      announce({ photoId: job.photoId, status: SHARE.FAILED, error: err.message });
      return;
    }

    const delay = backoffMs(attempts);
    repo.markShare(job.photoId, SHARE.PENDING, {
      attempts,
      nextAttemptAt: Date.now() + delay,
      error: err.message,
    });
    log('warn', 'publicação falhou, reagendada', {
      captureId: job.photoId,
      attempts,
      retryInMs: delay,
      error: err.message,
    });
    announce({ photoId: job.photoId, status: SHARE.PENDING, error: err.message });
  }

  /**
   * Processa o que já venceu. Exposto para o teste poder rodar a fila
   * passo a passo, sem depender de temporizador.
   */
  async function tick() {
    if (running) return { processed: 0, skipped: 'já rodando' };
    running = true;

    let processed = 0;
    try {
      const jobs = repo.dueShareJobs(config.cloud.batchSize);
      for (const job of jobs) {
        try {
          await publishOne(job);
        } catch (err) {
          handleFailure(job, err);
        }
        processed++;
      }
    } finally {
      running = false;
    }

    return { processed };
  }

  return {
    tick,

    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch(err => log('error', 'fila de publicação quebrou', { error: err.message }));
      }, config.cloud.pollMs);
      timer.unref?.();
      log('info', 'fila de publicação iniciada', {
        driver: publisher.kind,
        pendentes: repo.shareStats().pending_sync,
      });
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Devolve tudo que desistiu para a fila — o "tentar de novo" do painel. */
    retryFailed() {
      repo.retryFailedShares();
      return tick();
    },

    status() {
      return {
        driver: publisher.kind,
        configured: publisher.configured,
        running: !!timer,
        lastError,
        lastPublishedAt,
        ...repo.shareStats(),
      };
    },
  };
}

module.exports = { createShareQueue, backoffMs };
