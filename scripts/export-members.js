require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// Lista de todos os chat_ids dos grupos/canais
const groups = [
  { name: 'Bate-Papo 1', chatId: '-1001677560234', plan: 'CF VIP - FATOS DA BOLSA 1' },
  { name: 'Bate-Papo 2', chatId: '-1001854290732', plan: 'CF VIP - FATOS DA BOLSA 2' },
  { name: 'Bate-Papo 3', chatId: '-1001770950182', plan: 'CF VIP - FATOS DA BOLSA 3' },
  { name: 'Milhas', chatId: '-1001662496741', plan: 'Todos VIP' },
  { name: 'Atualizações CF VIP', chatId: '-1001848040585', plan: 'Todos VIP' },
  { name: 'Atualizações CF LITE', chatId: '-1001696501981', plan: 'Close Friends LITE' },
  { name: 'Projeto Renda Passiva', chatId: '-1002037275118', plan: 'Projeto Renda Passiva' }
];

async function exportMembers() {
  console.log('📊 Exportando membros dos grupos...\n');

  const allMembers = [];
  const membersByGroup = {};
  const uniqueMembers = new Map();

  for (const group of groups) {
    try {
      const chat = await bot.getChat(group.chatId);
      console.log(`\n📱 Grupo: ${group.name}`);

      const memberCount = await bot.getChatMemberCount(group.chatId);
      console.log(`👥 Total de membros: ${memberCount}`);

      membersByGroup[group.name] = [];

      // ATENÇÃO: A API do Telegram tem limitações para listar membros
      // Apenas grupos pequenos (<200) ou se o bot for admin com permissões especiais

      // Tenta obter lista de administradores primeiro
      const admins = await bot.getChatAdministrators(group.chatId);
      
      console.log(`👑 Administradores: ${admins.length}`);

      for (const admin of admins) {
        const user = admin.user;
        
        const memberInfo = {
          telegram_id: user.id.toString(),
          username: user.username || null,
          first_name: user.first_name || '',
          last_name: user.last_name || '',
          full_name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
          is_bot: user.is_bot,
          status: admin.status,
          group: group.name,
          plan: group.plan
        };

        membersByGroup[group.name].push(memberInfo);
        
        // Adiciona ao mapa de únicos
        if (!uniqueMembers.has(user.id.toString())) {
          uniqueMembers.set(user.id.toString(), {
            ...memberInfo,
            groups: [group.name]
          });
        } else {
          uniqueMembers.get(user.id.toString()).groups.push(group.name);
        }

        console.log(`  👤 ${memberInfo.full_name || memberInfo.username || memberInfo.telegram_id} (${admin.status})`);
      }

      console.log(`✅ Exportados: ${membersByGroup[group.name].length} admins`);

      // LIMITAÇÃO: Membros comuns não podem ser listados facilmente
      // A API do Telegram não fornece método direto para isso
      console.log(`⚠️ Membros comuns: Não disponível via API (limitação do Telegram)`);
      console.log(`   Apenas admins foram exportados.`);

    } catch (error) {
      console.error(`❌ Erro ao processar ${group.name}:`, error.message);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Exporta para arquivos

  // 1. CSV por grupo
  let csvContent = 'Telegram ID,Username,Nome,Sobrenome,Nome Completo,É Bot,Status,Grupo,Plano\n';
  
  for (const groupName in membersByGroup) {
    for (const member of membersByGroup[groupName]) {
      csvContent += `${member.telegram_id},${member.username || ''},${member.first_name},${member.last_name},${member.full_name},${member.is_bot},${member.status},${member.group},${member.plan}\n`;
    }
  }

  fs.writeFileSync('members-by-group.csv', csvContent);
  console.log('\n✅ Arquivo criado: members-by-group.csv');

  // 2. CSV de membros únicos
  let uniqueCsvContent = 'Telegram ID,Username,Nome Completo,Grupos,Total de Grupos\n';
  
  for (const [id, member] of uniqueMembers) {
    if (!member.is_bot) {  // Remove bots da lista
      uniqueCsvContent += `${id},${member.username || ''},${member.full_name},"${member.groups.join(', ')}",${member.groups.length}\n`;
    }
  }

  fs.writeFileSync('members-unique.csv', uniqueCsvContent);
  console.log('✅ Arquivo criado: members-unique.csv');

  // 3. JSON completo
  const exportData = {
    export_date: new Date().toISOString(),
    total_unique_members: uniqueMembers.size,
    by_group: membersByGroup,
    unique_members: Array.from(uniqueMembers.values())
  };

  fs.writeFileSync('members-export.json', JSON.stringify(exportData, null, 2));
  console.log('✅ Arquivo criado: members-export.json');

  // 4. Script SQL para importar
  let sqlContent = '-- Importação de membros existentes\n\n';
  
  for (const [id, member] of uniqueMembers) {
    if (!member.is_bot) {
      // Determina o plano baseado nos grupos
      let plan = 'CF VIP - FATOS DA BOLSA 1';  // Padrão
      
      if (member.groups.includes('Projeto Renda Passiva')) {
        plan = 'Projeto Renda Passiva';
      } else if (member.groups.includes('Atualizações CF LITE') && member.groups.length === 1) {
        plan = 'Close Friends LITE';
      }

      sqlContent += `-- ${member.full_name || member.username}\n`;
      sqlContent += `INSERT INTO subscribers (name, email, phone, plan, status, origin) VALUES \n`;
      sqlContent += `  ('${member.full_name.replace(/'/g, "''")}', '${member.username || 'sem-email'}@telegram.user', '00000000000', '${plan}', 'active', 'manual')\n`;
      sqlContent += `ON CONFLICT (email) DO NOTHING;\n\n`;
      
      sqlContent += `INSERT INTO authorized_users (telegram_id, subscriber_id, authorized, authorized_at) \n`;
      sqlContent += `SELECT '${id}', id, true, NOW() FROM subscribers WHERE email = '${member.username || 'sem-email'}@telegram.user'\n`;
      sqlContent += `ON CONFLICT (telegram_id) DO NOTHING;\n\n`;
    }
  }

  fs.writeFileSync('import-members.sql', sqlContent);
  console.log('✅ Arquivo criado: import-members.sql');

  console.log('\n📊 Resumo:');
  console.log(`   Total de usuários únicos: ${uniqueMembers.size}`);
  console.log(`   (Bots foram filtrados do SQL)\n`);

  console.log('⚠️ IMPORTANTE:');
  console.log('   A API do Telegram NÃO permite listar todos os membros comuns.');
  console.log('   Apenas ADMINISTRADORES foram exportados.');
  console.log('   Para ter lista completa, você precisaria:');
  console.log('   1. Pedir que membros se registrem pelo bot, ou');
  console.log('   2. Ter exportação manual do Telegram Desktop\n');

  process.exit(0);
}

exportMembers();