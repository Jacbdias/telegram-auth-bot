# Fluxo de assinantes com múltiplos planos

## O que acontece ao adicionar um segundo plano manualmente
- O registro do assinante armazena todos os planos mesclados no campo `plan` (por exemplo: `CF VIP - FATOS DA BOLSA 3, Mentoria Renda Turbinada`).
- Se o assinante já se autenticou no bot, ele continua autorizado — não é necessário refazer a verificação.

## Como o assinante recebe os novos links
- O bot **não envia automaticamente** os novos convites quando o campo `plan` é atualizado manualmente ou via importação.
- O próprio assinante pode gerar novos convites a qualquer momento executando o comando `/meuscanais` no bot. Esse comando consulta os planos atuais do usuário e cria links de convite válidos para todos os canais correspondentes.
- Se o assinante tentar usar `/start` após já estar autorizado, o bot apenas lembra que ele já tem acesso e orienta a usar `/meuscanais`.

## Papel da sincronização manual
- O botão **“Sincronizar Agora”** no painel de admin (/api/admin/sync) serve apenas para revogar o acesso de assinantes marcados como inativos. Ele não reenvia convites nem recalcula planos.

## Resumo prático
- Para entregar os links dos novos grupos depois de adicionar um segundo plano, peça ao assinante para enviar `/meuscanais` ao bot. Isso renova todos os links com base na lista atual de planos sem exigir nova autenticação.
