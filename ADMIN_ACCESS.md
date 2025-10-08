# Admin Access Configuration

O painel `/admin.html` agora permite cadastrar e gerenciar usuários administradores diretamente pela interface — não é mais necessário editar o código para adicionar credenciais.

## Como funciona a autenticação

- O backend utiliza a rota [`adminAuth`](web/admin-routes.js) para validar o header `Authorization: Bearer usuario:senha`.
- As credenciais são armazenadas na tabela `admin_users` do banco PostgreSQL (veja [`schema.sql`](schema.sql)). As senhas são salvas com hash seguro (`bcrypt` quando disponível, com fallback automático para `PBKDF2`).
- Para compatibilidade, ainda existem credenciais padrão (`admin` e `jacbdias`). Na primeira autenticação elas são migradas automaticamente para o banco. Recomenda-se alterar essas senhas ou criar novos usuários e remover os padrões.

## Cadastrar novos administradores via painel

1. Acesse `/admin.html` com um usuário administrador existente.
2. Clique na aba **Administradores**.
3. Use o botão **+ Novo Administrador** para abrir o modal.
4. Informe o nome de usuário e uma senha com no mínimo 8 caracteres.
5. Salve para registrar o novo acesso. A senha será criptografada automaticamente.

Também é possível:

- Atualizar a senha de um administrador existente pelo botão **Atualizar senha**.
- Remover administradores (exceto o usuário logado e o último restante, para evitar ficar sem acesso).

Todas as operações são feitas através das rotas `/api/admin/admins` documentadas em [`web/admin-routes.js`](web/admin-routes.js).
