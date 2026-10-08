# Regras de acesso da Hotmart no bot

As mesmas regras de negócio do portal (`MembrosFatosdaBolsa`), aplicadas no bot
sem depender dele. Quem decide é `web/hotmart-processor.js`; as listas e os
mapas estão em `web/hotmart-utils.js`.

## As quatro regras

| # | Regra | O que o bot faz |
| --- | --- | --- |
| 1 | **Renovação cancelada** | Acesso **até o fim do período já pago**. Não corta na hora. |
| 2 | **Reembolso, chargeback e disputa** | Cortam na hora. |
| 3 | **Atraso** | Corta quando chega o status `delayed`/`overdue`, sem tolerância. |
| 4 | **Rebaixamento** | Só por compra nova. Troca de plano para baixo **não** rebaixa. |

## 1. Cancelamento de renovação: acesso até o fim do período pago

`SUBSCRIPTION_CANCELLATION` (e as grafias v1.0 `subscription.canceled` /
`subscription_cancelled`) **não corta mais na hora**. O bot:

1. resolve o plano daquela assinatura;
2. lê a data da próxima cobrança do payload — o caminho real no cancelamento é
   **`data.date_next_charge`** (em epoch ms ou ISO; os dois são aceitos);
3. grava em `subscriber_plan_access` que aquele plano daquele assinante vale
   até essa data (`reason = 'subscription_cancellation'`).

**Sem a data**, nada é cortado: o evento é registrado em
`webhook_hotmart_cancellation_review` com `reason = next_charge_missing`.

**Sem a tabela** (o SQL manual ainda não rodou), também nada é cortado: o log
sai com `reason = plan_access_table_missing` e a data lida, para dar tempo de
rodar o SQL sem perder o caso.

### O job diário

`web/plan-access-job.js` roda no mesmo processo (uma passada ~1 min depois do
boot e depois a cada 24h). Para cada linha vencida ele:

- remove **só aquele plano** com `deactivateSubscriberByEmail(email, { plan })`;
- revoga os convites e tira a pessoa dos canais daquele plano, como o `/sync`;
- **mantém as outras assinaturas** da pessoa;
- apaga a linha só depois da remoção — se a remoção falhar, tenta no próximo
  tick.

Intervalos configuráveis por `PLAN_ACCESS_JOB_INTERVAL_MS` e
`PLAN_ACCESS_JOB_START_DELAY_MS`.

### Reativação

Uma ativação nova do mesmo plano (`PURCHASE_APPROVED` ou renovação paga)
**apaga** o `access_until` daquele plano: a pessoa reativou ou comprou de novo.

## 2. Só eventos explícitos ativam

A ativação acontece **só** por evento de `ACTIVATION_EVENTS`
(`PURCHASE_APPROVED`, `PURCHASE_COMPLETE`, `SUBSCRIPTION_RENEWED`, …). **O
status do payload não ativa mais ninguém.**

Por que isso importa: `SWITCH_PLAN` e `UPDATE_SUBSCRIPTION_CHARGE_DATE` chegam
com `subscription.status = ACTIVE`, e antes viravam ativação pelo status — o que
podia **reativar uma assinatura reembolsada** que a Hotmart continua mostrando
como ACTIVE (caso real, confirmado no painel).

Para **desativar**, o status ainda decide, mas só em `delayed` e `overdue`
(`DEACTIVATION_STATUS_FALLBACK`). É seguro porque esse fallback só roda para
evento desconhecido ou ausente — todos os eventos conhecidos são tratados antes:

| Evento | Tratamento | Status é usado? |
| --- | --- | --- |
| `UPDATE_SUBSCRIPTION_CHARGE_DATE` | 202, só registra | não |
| `SUBSCRIPTION_CANCELLATION` | agenda o fim do acesso | não |
| `SWITCH_PLAN` | migração ou revisão | não |
| `PURCHASE_APPROVED` e cia. | ativa | não |
| `PURCHASE_REFUNDED`/`CHARGEBACK`/`PROTEST` | corta na hora | não |
| desconhecido / ausente | corta **se** `delayed`/`overdue` | sim |

Um status de cancelamento (`canceled`, `cancelled`) num evento desconhecido
**não corta mais**: cortar ali contrariaria a regra 1.

## 3. Troca de plano pelo ID do plano

Alguns produtos LITE vendem planos VIP dentro. Decidir pelo **nome da oferta**
erra nesses casos; o **id do plano** não erra. O mapa
`BUILTIN_PLAN_ID_MAPPING` é a lista confirmada pelo Davi, a mesma de
`HOTMART_PLAN_EXCEPTIONS` no portal:

| Produto | Planos VIP | Planos LITE_V2 |
| --- | --- | --- |
| 1874171 | 830231, 494607, 773294 | |
| 3129181 | 810167 | 699092 |
| 3671256 | 853270, 773559, 706794 | |
| 5060609 | 1263167, 1063182, 1381590 | |
| 3547657 | 853268 | 687186 |

A ordem de resolução do plano é:

1. **mapa por plano** (`plan.id`) — inclusive uma entrada do
   `HOTMART_PLAN_MAP` para aquele id, que ganha da lista interna;
2. mapa por oferta (`offer.code` / `offer.id`);
3. mapa por produto (`product.id` / nome);
4. nome do plano / `HOTMART_DEFAULT_PLAN`.

Um plano VIP dentro de um **produto LITE** é tratado como **migração** para
`CF VIP - FATOS DA BOLSA 3`: o LITE é substituído e os outros planos são
preservados. Vale também para a `PURCHASE_APPROVED` desses planos.

Um plano VIP dentro de um produto que **não** é LITE (ex.: plano 853268 no
produto 3547657, Projeto Renda Passiva) resolve para VIP, mas **não substitui**
nada — só a migração LITE → VIP substitui plano.

### `SWITCH_PLAN`

A troca nativa da Hotmart manda o plano novo em `data.plans[]` com
`current: true`, e **não** manda `data.product`.

- plano novo é VIP pelo mapa **e** a pessoa tem o LITE no bot → migra: troca o
  LITE pelo VIP e preserva os outros planos;
- **qualquer outra troca** é registrada em
  `webhook_hotmart_switch_plan_review` e **não muda nada**. Os motivos:
  `current_plan_missing`, `new_plan_not_vip` (inclui o rebaixamento),
  `subscriber_not_found`, `subscriber_inactive`, `subscriber_without_lite`.

O payload de `SWITCH_PLAN` não traz nome nem telefone: a migração preserva os
que já estão no banco, para não sobrescrever com vazio.

### A busca por palavra continua como reserva

Para payloads **sem** `plan.id`, a detecção por palavra no nome da oferta
(`HOTMART_MIGRATION_KEYWORDS`) continua valendo exatamente como antes.

## 4. Hottok

A comparação do `X-Hotmart-Hottok` usa `crypto.timingSafeEqual` sobre o
**SHA-256 dos dois lados** (`timingSafeHottokMatches`), para o tempo não
depender do conteúdo nem do tamanho. Antes era `!==`.

## Como conferir em produção

```sql
-- Agendamentos ativos
SELECT spa.plan, spa.access_until, spa.reason, s.email
FROM subscriber_plan_access spa
JOIN subscribers s ON s.id = spa.subscriber_id
ORDER BY spa.access_until;
```

Nos logs do serviço do bot:

- `webhook_hotmart_processed` com `action = access_scheduled` — cancelamento
  agendado (traz `access_until` e `access_until_path`);
- `webhook_hotmart_cancellation_review` — cancelamento que **não** agendou;
- `webhook_hotmart_switch_plan_review` — troca de plano que foi para revisão;
- `plan_access_job_started` / `plan_access_job_done` / `plan_access_job_revoked`
  — o job diário;
- `plan_access_table_missing` — o SQL manual ainda não rodou.
