// Nomes antigos de plano que ainda aparecem em alguns assinantes (compras da
// Hotmart de dez/2025). Nenhum canal é cadastrado com esses nomes, então na
// REMOÇÃO o bot não achava grupo nenhum e a pessoa continuava dentro.
//
// Só a remoção usa este mapa. Na liberação o nome antigo do VIP não diz qual
// Bate-Papo é o da pessoa; tirar de todos os VIPs é seguro, colocar em todos
// não é.
const PLANOS_LEGADOS = new Map([
  ['fatos da bolsa - close friends vip', ['CF VIP - FATOS DA BOLSA 1', 'CF VIP - FATOS DA BOLSA 2', 'CF VIP - FATOS DA BOLSA 3']],
  ['fatos da bolsa - close friends lite', ['Close Friends LITE']]
]);

function chave(plano) {
  return String(plano || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Lista de planos com os nomes antigos trocados pelos atuais (sem repetir). */
function expandirPlanosLegados(planos) {
  const lista = Array.isArray(planos)
    ? planos
    : String(planos || '')
        .split(/[,;\n]/)
        .map((p) => p.trim())
        .filter(Boolean);
  const saida = [];
  for (const plano of lista) {
    for (const p of PLANOS_LEGADOS.get(chave(plano)) || [plano]) {
      if (!saida.includes(p)) saida.push(p);
    }
  }
  return saida;
}

module.exports = { expandirPlanosLegados, PLANOS_LEGADOS };
