# Integração Hotmart → Bot do Telegram

Este guia explica como conectar os eventos de venda da Hotmart ao bot. A sincronização acontece via webhook: sempre que uma compra é aprovada ou cancelada, a Hotmart chama `/api/hotmart/webhook` e o backend atualiza automaticamente a tabela `subscribers`.

## 1. Preparar variáveis de ambiente

Adicione os seguintes valores ao arquivo `.env` (ou às variáveis do serviço em produção):

| Variável | Descrição |
| --- | --- |
| `HOTMART_WEBHOOK_SECRET` | Token secreto configurado no painel Hotmart para assinar os webhooks. Sem ele a requisição é rejeitada. |
| `HOTMART_PLAN_MAP` | JSON que mapeia `offer.code`, `offer.id` ou `product.id` para o `plan` cadastrado no banco. Ex.: `{ "OFERTA_VIP": "vip", "123456": "premium" }`. |
| `HOTMART_DEFAULT_PLAN` | (Opcional) Plano aplicado quando o evento não corresponde a nenhuma chave do `HOTMART_PLAN_MAP`. |

> **Dica:** mantenha o JSON da variável `HOTMART_PLAN_MAP` simples, sem quebras de linha. Cada chave pode ser o código da oferta (mais comum), o ID numérico do produto ou até o nome do plano, desde que esteja em minúsculas para facilitar o match.

## 2. Criar o webhook na Hotmart

1. Acesse [app.hotmart.com](https://app.hotmart.com) com seu usuário.
2. No menu lateral, clique em **Ferramentas → Webhooks (HotConnect)**.
3. Clique em **Novo webhook** e preencha:
   - **Nome:** algo como `Bot Telegram`.
   - **URL:** `https://SEU_DOMÍNIO/api/hotmart/webhook` (use HTTPS). Em ambiente local você pode usar um túnel (ngrok) para testar.
   - **Token secreto:** gere uma sequência aleatória e copie para `HOTMART_WEBHOOK_SECRET`.
4. Na seção **Eventos**, marque pelo menos:
   - `purchase.approved`
   - `purchase.completed`
   - `subscription.approved`
   - `subscription.renewed`
   - `purchase.canceled`
   - `purchase.refunded`
   - `subscription.canceled`
5. Salve o webhook.

## 3. Mapear ofertas para planos

No painel Hotmart, cada produto/oferta possui um código. Copie esse valor (fica em **Produtos → Ofertas → Detalhes**) e inclua no JSON do `HOTMART_PLAN_MAP`. Exemplo completo:

```json
{
  "oferta_vip": "vip",
  "OFERTA_PREMIUM": "premium",
  "123456": "basico"
}
```

No código o mapeamento é lido de forma case-insensitive, então `oferta_vip` e `OFERTA_VIP` funcionam da mesma forma.

> Dica rápida: os produtos `5060349` e `5060609` já têm fallback interno para `Close Friends VIP` e `Close Friends LITE`, respectivamente. Mesmo assim, vale registrá-los no `HOTMART_PLAN_MAP` para manter tudo documentado no ambiente.

## 4. Testar o fluxo

1. No painel Hotmart, use a opção **Enviar teste** dentro do webhook recém-criado.
2. Informe um email e telefone fictícios que você conheça.
3. Verifique os logs do servidor: você deve ver a mensagem `success: true` no retorno.
4. Confirme no banco `subscribers` que o email foi inserido/atualizado com `status = 'active'`.
5. Faça outro teste marcando o evento de cancelamento e verifique se o `status` foi alterado para `inactive` e se o acesso foi revogado.

## 5. Fluxo após o webhook

- Compras aprovadas executam `upsertSubscriberFromHotmart`: o assinante é criado/atualizado como `active` e com o plano correto.
- Cancelamentos, estornos ou suspensões executam `deactivateSubscriberByEmail`: o status vira `inactive` e o bot revoga o acesso/links existentes.
- O usuário precisa apenas abrir o bot e informar email/telefone. Se já estiver autorizado, pode usar `/meuscanais` para gerar novos convites.

Com isso, as vendas da Hotmart passam a atualizar o bot automaticamente, sem necessidade de planilhas intermediárias.
