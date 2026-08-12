# Fluxo de assinantes com múltiplos planos

## O que acontece ao adicionar um segundo plano manualmente
- O registro do assinante armazena todos os planos mesclados no campo `plan` (por exemplo: `CF VIP - FATOS DA BOLSA 3, Mentoria Renda Turbinada`).
- Se o assinante já se autenticou no bot, ele continua autorizado — não é necessário refazer a verificação.

## Exceção: migração LITE → VIP via webhook (substituição, não mesclagem)
- A regra geral acima é de **acúmulo** (novos planos são mesclados). A migração LITE → VIP é a exceção: em vez de mesclar, ela **substitui** o plano de origem pelo de destino.
- O webhook identifica a migração quando o produto base resolve para LITE e o **nome da oferta** contém um termo de migração (`migração vip`, `vip`, `troca de plano`, etc. — ver `HOTMART_MIGRATION_KEYWORDS`).
- Ao migrar, o `Close Friends LITE` é removido e o `CF VIP - FATOS DA BOLSA 3` é adicionado. **Outros planos do assinante são preservados** (ex.: `Mentoria Renda Turbinada`).
- Como em qualquer atualização de plano, o bot **não** reenvia os convites automaticamente: o assinante deve usar `/meuscanais` para gerar os links dos novos canais VIP.

## Como o assinante recebe os novos links
- O bot **não envia automaticamente** os novos convites quando o campo `plan` é atualizado manualmente ou via importação.
- O próprio assinante pode gerar novos convites a qualquer momento executando o comando `/meuscanais` no bot. Esse comando consulta os planos atuais do usuário e cria links de convite válidos para todos os canais correspondentes.
- Se o assinante tentar usar `/start` após já estar autorizado, o bot apenas lembra que ele já tem acesso e orienta a usar `/meuscanais`.

## Papel da sincronização manual
- O botão **“Sincronizar Agora”** no painel de admin (/api/admin/sync) serve apenas para revogar o acesso de assinantes marcados como inativos. Ele não reenvia convites nem recalcula planos.

## Resumo prático
- Para entregar os links dos novos grupos depois de adicionar um segundo plano, peça ao assinante para enviar `/meuscanais` ao bot. Isso renova todos os links com base na lista atual de planos sem exigir nova autenticação.
- Se você remover um dos planos manualmente pelo painel **Editar Assinante**, somente os grupos ligados ao plano removido serão revogados para usuários já autorizados; os demais grupos permanecem acessíveis.
