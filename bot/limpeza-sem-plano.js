// Limpeza única de quem perdeu o ÚLTIMO plano antes da correção de 18/11/2026.
//
// Até o PR #90, remover o último plano de alguém apagava o plano do cadastro
// e desativava a autorização, mas não tirava a pessoa dos grupos (sem plano,
// nenhum canal era selecionado). Essas pessoas ficaram com o plano vazio no
// bot, então nem a conferência diária com o portal nem o /revogar alcançam.
//
// Duas etapas, as duas pelo admin no Telegram:
//   /limpar_sem_plano            pergunta ao Telegram quem ainda está em cada
//                                grupo e lista. Não remove ninguém.
//   /limpar_sem_plano confirmar  remove exatamente o que a última lista
//                                mostrou (vale por 30 minutos).
//
// Ficam de fora: quem o Telegram mostra como administrador do grupo e quem
// tem a mesma conta de Telegram vinculada a outro cadastro com plano ativo.

const PRESENTE = new Set(['member', 'restricted']);
const ADMIN = new Set(['administrator', 'creator']);
// O Telegram responde assim para conta apagada ou que nunca passou pelo grupo.
const NAO_ESTA = /PARTICIPANT_ID_INVALID|user not found|USER_ID_INVALID/i;

const SQL_CANDIDATOS = `
  SELECT s.email, au.telegram_id
  FROM subscribers s
  JOIN authorized_users au ON au.subscriber_id = s.id
  WHERE au.telegram_id IS NOT NULL
    AND coalesce(trim(s.plan), '') = ''
    AND NOT EXISTS (
      SELECT 1
      FROM authorized_users au2
      JOIN subscribers s2 ON s2.id = au2.subscriber_id
      WHERE au2.telegram_id = au.telegram_id
        AND s2.id <> s.id
        AND s2.status = 'active'
        AND coalesce(trim(s2.plan), '') <> ''
    )
  ORDER BY s.updated_at DESC`;

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Um grupo por chat_id (o mesmo grupo aparece em vários planos).
function gruposUnicos(canais) {
  const porChat = new Map();
  for (const c of canais) {
    if (!c.active || !c.chat_id) continue;
    const id = String(c.chat_id);
    if (!porChat.has(id)) porChat.set(id, { chat_id: id, nome: c.name });
  }
  return Array.from(porChat.values());
}

function createLimpezaSemPlano({
  db,
  bot,
  logger,
  pausaMs = 60,
  validadeMs = 30 * 60 * 1000,
  now = () => Date.now(),
  esperar = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
  let pendente = null;

  async function conferir() {
    const { rows } = await db.pool.query(SQL_CANDIDATOS);
    const grupos = gruposUnicos(await db.getAllChannels());

    const presentes = [];
    const admins = [];
    const erros = [];

    for (const pessoa of rows) {
      const telegramId = String(pessoa.telegram_id);
      const dentro = [];
      for (const g of grupos) {
        try {
          const membro = await bot.getChatMember(g.chat_id, telegramId);
          if (PRESENTE.has(membro?.status)) dentro.push(g);
          else if (ADMIN.has(membro?.status)) admins.push({ email: pessoa.email, grupo: g.nome });
        } catch (error) {
          if (!NAO_ESTA.test(error?.message || '')) {
            erros.push({ email: pessoa.email, grupo: g.nome, erro: error?.message || 'erro' });
          }
        }
        await esperar(pausaMs);
      }
      if (dentro.length > 0) presentes.push({ email: pessoa.email, telegram_id: telegramId, grupos: dentro });
    }

    pendente = { em: now(), presentes };
    logger.info('limpeza_sem_plano_conferida', {
      candidatos: rows.length,
      presentes: presentes.length,
      vinculos: presentes.reduce((n, p) => n + p.grupos.length, 0),
      admins: admins.length,
      erros: erros.length
    });
    return { candidatos: rows.length, presentes, admins, erros };
  }

  async function remover() {
    if (!pendente || now() - pendente.em > validadeMs) {
      pendente = null;
      return { semLista: true };
    }
    const { presentes } = pendente;
    pendente = null;

    const ok = [];
    const falhas = [];
    for (const pessoa of presentes) {
      const removidos = [];
      for (const g of pessoa.grupos) {
        try {
          await bot.banChatMember(g.chat_id, pessoa.telegram_id);
          await bot.unbanChatMember(g.chat_id, pessoa.telegram_id);
          removidos.push(g.nome);
        } catch (error) {
          falhas.push({ email: pessoa.email, grupo: g.nome, erro: error?.message || 'erro' });
        }
        await esperar(pausaMs * 5);
      }
      if (removidos.length > 0) ok.push({ email: pessoa.email, grupos: removidos });
    }

    logger.info('limpeza_sem_plano_removida', { pessoas: ok.length, falhas: falhas.length });
    return { ok, falhas };
  }

  function textoConferencia(r) {
    const partes = [`🔎 <b>Sem plano no bot, mas ainda nos grupos</b>\nConferidos: ${r.candidatos} cadastros.`];
    if (r.presentes.length === 0) {
      partes.push('✅ Ninguém sem plano está em grupo pago.');
    } else {
      partes.push(
        `<b>${r.presentes.length} pessoas</b>\n` +
          r.presentes.map((p) => `• ${esc(p.email)} → ${p.grupos.map((g) => esc(g.nome)).join(', ')}`).join('\n')
      );
      partes.push('Para tirar essas pessoas desses grupos: /limpar_sem_plano confirmar\n(vale por 30 minutos)');
    }
    if (r.admins.length > 0) {
      partes.push(
        `ℹ️ Administradores, não mexi:\n` + r.admins.map((a) => `• ${esc(a.email)} → ${esc(a.grupo)}`).join('\n')
      );
    }
    if (r.erros.length > 0) {
      partes.push(
        `⚠️ Não deu para conferir:\n` + r.erros.map((e) => `• ${esc(e.email)} → ${esc(e.grupo)}: ${esc(e.erro)}`).join('\n')
      );
    }
    return partes.join('\n\n');
  }

  function textoRemocao(r) {
    if (r.semLista) {
      return 'Nenhuma lista recente. Rode /limpar_sem_plano primeiro e confirme em até 30 minutos.';
    }
    const partes = [];
    partes.push(
      r.ok.length > 0
        ? `✅ <b>Removidos (${r.ok.length})</b>\n` +
            r.ok.map((p) => `• ${esc(p.email)} → ${p.grupos.map(esc).join(', ')}`).join('\n')
        : 'Ninguém foi removido.'
    );
    if (r.falhas.length > 0) {
      partes.push(
        `❌ <b>O Telegram recusou (${r.falhas.length})</b>\n` +
          r.falhas.map((f) => `• ${esc(f.email)} → ${esc(f.grupo)}: ${esc(f.erro)}`).join('\n')
      );
    }
    return partes.join('\n\n');
  }

  return { conferir, remover, textoConferencia, textoRemocao };
}

// Mensagens do Telegram vão até 4096 caracteres: quebra por linha.
function dividirMensagem(texto, limite = 3800) {
  const partes = [];
  let atual = '';
  for (const linha of String(texto).split('\n')) {
    if (atual && atual.length + linha.length + 1 > limite) {
      partes.push(atual);
      atual = '';
    }
    atual = atual ? `${atual}\n${linha}` : linha;
  }
  if (atual) partes.push(atual);
  return partes;
}

module.exports = { createLimpezaSemPlano, dividirMensagem, gruposUnicos, SQL_CANDIDATOS };
