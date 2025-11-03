// Configuração
const API_URL = 'https://telegram-auth-bot-production.up.railway.app/api/admin';
let authToken = localStorage.getItem('adminToken') || '';

// Verifica se já está logado
if (authToken) {
    showDashboard();
}

// ============== LOGIN ==============

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const password = document.getElementById('password').value;
    const alert = document.getElementById('loginAlert');
    
    // Testa a senha fazendo uma requisição
    try {
        const response = await fetch(`${API_URL}/stats`, {
            headers: {
                'Authorization': `Bearer ${password}`
            }
        });
        
        if (response.ok) {
            authToken = password;
            localStorage.setItem('adminToken', password);
            showDashboard();
        } else {
            alert.textContent = '❌ Senha incorreta!';
            alert.classList.add('show');
            setTimeout(() => alert.classList.remove('show'), 3000);
        }
    } catch (error) {
        alert.textContent = '❌ Erro ao conectar ao servidor';
        alert.classList.add('show');
    }
});

function logout() {
    localStorage.removeItem('adminToken');
    authToken = '';
    document.getElementById('loginContainer').style.display = 'flex';
    document.getElementById('dashboard').classList.remove('active');
}

function showDashboard() {
    document.getElementById('loginContainer').style.display = 'none';
    document.getElementById('dashboard').classList.add('active');
    loadStats();
    loadSubscribers();
    loadChannels();
    loadLogs();
}

// ============== REQUISIÇÕES ==============

async function apiRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json'
        }
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    const response = await fetch(`${API_URL}${endpoint}`, options);
    
    if (!response.ok) {
        throw new Error('Erro na requisição');
    }
    
    return response.json();
}

// ============== TABS ==============

function showTab(tabName) {
    // Remove active de todas as tabs
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    
    // Ativa a tab clicada
    event.target.classList.add('active');
    document.getElementById(tabName + 'Tab').classList.add('active');
}

// ============== STATS ==============

async function loadStats() {
    try {
        const stats = await apiRequest('/stats');
        
        document.getElementById('totalSubscribers').textContent = stats.totalActiveSubscribers || 0;
        document.getElementById('totalAuthorized').textContent = stats.totalAuthorizedUsers || 0;
        
        // Conta total de canais
        const channels = await apiRequest('/channels');
        document.getElementById('totalChannels').textContent = channels.length || 0;
    } catch (error) {
        console.error('Erro ao carregar estatísticas:', error);
    }
}

// ============== ASSINANTES ==============

async function loadSubscribers() {
    try {
        const subscribers = await apiRequest('/subscribers');
        
        let html = `
            <table>
                <thead>
                    <tr>
                        <th>Nome</th>
                        <th>Email</th>
                        <th>Telefone</th>
                        <th>Plano</th>
                        <th>Status</th>
                        <th>Telegram</th>
                        <th>Ações</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        subscribers.forEach(sub => {
            const statusBadge = sub.status === 'active' ? 'badge-success' : 'badge-danger';
            const statusText = sub.status === 'active' ? 'Ativo' : 'Inativo';
            const hasAuth = sub.authorized ? 'badge-success' : 'badge-warning';
            const authText = sub.authorized ? 'Autorizado' : 'Pendente';
            
            html += `
                <tr>
                    <td>${sub.name}</td>
                    <td>${sub.email}</td>
                    <td>${sub.phone}</td>
                    <td>${sub.plan}</td>
                    <td><span class="badge ${statusBadge}">${statusText}</span></td>
                    <td><span class="badge ${hasAuth}">${authText}</span></td>
                    <td class="actions">
                        <button class="btn-small btn-edit" onclick="editSubscriber(${sub.id})">Editar</button>
                        <button class="btn-small btn-delete" onclick="deleteSubscriber(${sub.id}, '${sub.name}')">Remover</button>
                    </td>
                </tr>
            `;
        });
        
        html += '</tbody></table>';
        document.getElementById('subscribersTable').innerHTML = html;
    } catch (error) {
        console.error('Erro ao carregar assinantes:', error);
    }
}

function openAddSubscriberModal() {
    document.getElementById('subscriberModalTitle').textContent = 'Novo Assinante';
    document.getElementById('subscriberForm').reset();
    document.getElementById('subscriberId').value = '';
    document.getElementById('subscriberStatus').value = 'active';
    document.getElementById('subscriberModal').classList.add('active');
}

async function editSubscriber(id) {
    try {
        const subscriber = await apiRequest(`/subscribers/${id}`);
        
        document.getElementById('subscriberModalTitle').textContent = 'Editar Assinante';
        document.getElementById('subscriberId').value = subscriber.id;
        document.getElementById('subscriberName').value = subscriber.name;
        document.getElementById('subscriberEmail').value = subscriber.email;
        document.getElementById('subscriberPhone').value = subscriber.phone;
        document.getElementById('subscriberPlan').value = subscriber.plan;
        document.getElementById('subscriberStatus').value = subscriber.status;
        
        document.getElementById('subscriberModal').classList.add('active');
    } catch (error) {
        alert('Erro ao carregar assinante');
    }
}

function closeSubscriberModal() {
    document.getElementById('subscriberModal').classList.remove('active');
}

document.getElementById('subscriberForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = document.getElementById('subscriberId').value;
    const data = {
        name: document.getElementById('subscriberName').value,
        email: document.getElementById('subscriberEmail').value,
        phone: document.getElementById('subscriberPhone').value,
        plan: document.getElementById('subscriberPlan').value,
        status: document.getElementById('subscriberStatus').value
    };
    
    try {
        if (id) {
            await apiRequest(`/subscribers/${id}`, 'PUT', data);
        } else {
            await apiRequest('/subscribers', 'POST', data);
        }
        
        closeSubscriberModal();
        loadSubscribers();
        loadStats();
        showAlert('subscriberModalAlert', 'Assinante salvo com sucesso!', 'success');
    } catch (error) {
        showAlert('subscriberModalAlert', 'Erro ao salvar assinante', 'error');
    }
});

async function deleteSubscriber(id, name) {
    if (!confirm(`Tem certeza que deseja remover ${name}?\n\nIsso também revogará o acesso dele aos grupos.`)) {
        return;
    }
    
    try {
        await apiRequest(`/subscribers/${id}`, 'DELETE');
        loadSubscribers();
        loadStats();
        alert('Assinante removido com sucesso!');
    } catch (error) {
        alert('Erro ao remover assinante');
    }
}

// ============== CANAIS ==============

async function loadChannels() {
    try {
        const channels = await apiRequest('/channels');
        
        let html = `
            <table>
                <thead>
                    <tr>
                        <th>Nome</th>
                        <th>Chat ID</th>
                        <th>Plano</th>
                        <th>Ordem</th>
                        <th>Pedido de entrada</th>
                        <th>Status</th>
                        <th>Ações</th>
                    </tr>
                </thead>
                <tbody>
        `;

        channels.forEach(channel => {
            const statusBadge = channel.active ? 'badge-success' : 'badge-danger';
            const statusText = channel.active ? 'Ativo' : 'Inativo';
            const joinRequestEnabled = Boolean(channel.creates_join_request);
            const joinRequestBadge = joinRequestEnabled ? 'badge-warning' : 'badge-info';
            const joinRequestText = joinRequestEnabled ? 'Sim' : 'Não';

            html += `
                <tr>
                    <td>${channel.name}</td>
                    <td><code>${channel.chat_id}</code></td>
                    <td>${channel.plan}</td>
                    <td>${channel.order_index}</td>
                    <td><span class="badge ${joinRequestBadge}">${joinRequestText}</span></td>
                    <td><span class="badge ${statusBadge}">${statusText}</span></td>
                    <td class="actions">
                        <button class="btn-small btn-edit" onclick="editChannel(${channel.id})">Editar</button>
                        <button class="btn-small btn-delete" onclick="deleteChannel(${channel.id}, '${channel.name}')">Remover</button>
                    </td>
                </tr>
            `;
        });
        
        html += '</tbody></table>';
        document.getElementById('channelsTable').innerHTML = html;
    } catch (error) {
        console.error('Erro ao carregar canais:', error);
    }
}

function openAddChannelModal() {
    document.getElementById('channelModalTitle').textContent = 'Novo Canal';
    document.getElementById('channelForm').reset();
    document.getElementById('channelId').value = '';
    document.getElementById('channelOrder').value = '0';
    document.getElementById('channelActive').value = 'true';
    document.getElementById('channelJoinRequest').checked = false;
    document.getElementById('channelModal').classList.add('active');
}

async function editChannel(id) {
    try {
        const channels = await apiRequest('/channels');
        const channel = channels.find(c => c.id === id);
        
        document.getElementById('channelModalTitle').textContent = 'Editar Canal';
        document.getElementById('channelId').value = channel.id;
        document.getElementById('channelName').value = channel.name;
        document.getElementById('channelChatId').value = channel.chat_id;
        document.getElementById('channelDescription').value = channel.description || '';
        document.getElementById('channelPlan').value = channel.plan;
        document.getElementById('channelOrder').value = channel.order_index;
        document.getElementById('channelActive').value = channel.active.toString();
        document.getElementById('channelJoinRequest').checked = Boolean(channel.creates_join_request);

        document.getElementById('channelModal').classList.add('active');
    } catch (error) {
        alert('Erro ao carregar canal');
    }
}

function closeChannelModal() {
    document.getElementById('channelModal').classList.remove('active');
}

document.getElementById('channelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const id = document.getElementById('channelId').value;
    const data = {
        name: document.getElementById('channelName').value,
        chat_id: document.getElementById('channelChatId').value,
        description: document.getElementById('channelDescription').value,
        plan: document.getElementById('channelPlan').value,
        order_index: parseInt(document.getElementById('channelOrder').value),
        active: document.getElementById('channelActive').value === 'true',
        creates_join_request: document.getElementById('channelJoinRequest').checked
    };
    
    try {
        if (id) {
            await apiRequest(`/channels/${id}`, 'PUT', data);
        } else {
            await apiRequest('/channels', 'POST', data);
        }
        
        closeChannelModal();
        loadChannels();
        loadStats();
    } catch (error) {
        showAlert('channelModalAlert', 'Erro ao salvar canal', 'error');
    }
});

async function deleteChannel(id, name) {
    if (!confirm(`Tem certeza que deseja remover o canal ${name}?`)) {
        return;
    }
    
    try {
        await apiRequest(`/channels/${id}`, 'DELETE');
        loadChannels();
        loadStats();
        alert('Canal removido com sucesso!');
    } catch (error) {
        alert('Erro ao remover canal');
    }
}

// ============== LOGS ==============

async function loadLogs() {
    try {
        const logs = await apiRequest('/logs');
        
        let html = `
            <table>
                <thead>
                    <tr>
                        <th>Data/Hora</th>
                        <th>Ação</th>
                        <th>Nome</th>
                        <th>Email</th>
                        <th>Telegram ID</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        logs.forEach(log => {
            const date = new Date(log.timestamp);
            const dateStr = date.toLocaleString('pt-BR');
            
            const actionBadge = log.action === 'authorized' ? 'badge-success' : 'badge-danger';
            const actionText = log.action === 'authorized' ? 'Autorizado' : 'Revogado';
            
            html += `
                <tr>
                    <td>${dateStr}</td>
                    <td><span class="badge ${actionBadge}">${actionText}</span></td>
                    <td>${log.name || '-'}</td>
                    <td>${log.email || '-'}</td>
                    <td><code>${log.telegram_id}</code></td>
                </tr>
            `;
        });
        
        html += '</tbody></table>';
        document.getElementById('logsTable').innerHTML = html;
    } catch (error) {
        console.error('Erro ao carregar logs:', error);
    }
}

// ============== UTILS ==============

function showAlert(elementId, message, type) {
    const alert = document.getElementById(elementId);
    alert.textContent = message;
    alert.className = `alert alert-${type} show`;
    setTimeout(() => alert.classList.remove('show'), 3000);
}

// ============== IMPORTAÇÃO EM MASSA ==============

let csvData = [];

function openImportModal() {
    document.getElementById('importModal').classList.add('active');
    document.getElementById('importResults').style.display = 'none';
    document.getElementById('importPreview').style.display = 'none';
    document.getElementById('csvFile').value = '';
    csvData = [];
}

function closeImportModal() {
    document.getElementById('importModal').classList.remove('active');
}

function downloadTemplate() {
    const template = 'nome,email,telefone,plano,status\n' +
                    'João Silva,joao@email.com,11999999999,CF VIP - FATOS DA BOLSA 1,active\n' +
                    'Maria Santos,maria@email.com,11988888888,CF VIP - FATOS DA BOLSA 2,active\n' +
                    'Ana Souza,ana@email.com,11966666666,Mentoria Renda Turbinada,active\n' +
                    'Pedro Costa,pedro@email.com,11977777777,Close Friends LITE,active';
    
    const blob = new Blob([template], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'modelo_importacao.csv';
    link.click();
}

document.getElementById('csvFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    
    if (!file) return;
    
    const reader = new FileReader();
    
    reader.onload = (event) => {
        const text = event.target.result;
        parseCSV(text);
    };
    
    reader.readAsText(file);
});

function parseCSV(text) {
    const lines = text.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
        showAlert('importAlert', 'Arquivo CSV vazio ou inválido', 'error');
        return;
    }
    
    // Primeira linha = headers
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    
    // Valida headers obrigatórios
    const required = ['nome', 'email', 'telefone', 'plano'];
    const missing = required.filter(r => !headers.includes(r));
    
    if (missing.length > 0) {
        showAlert('importAlert', `Colunas faltando: ${missing.join(', ')}`, 'error');
        return;
    }
    
    // Parse dados
    csvData = [];
    
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        const row = {};
        
        headers.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        
        csvData.push({
            name: row.nome,
            email: row.email,
            phone: row.telefone,
            plan: row.plano,
            status: row.status || 'active'
        });
    }
    
    // Mostra preview
    showPreview();
}

function showPreview() {
    const preview = csvData.slice(0, 5);
    
    let html = `
        <table style="width: 100%; font-size: 12px;">
            <thead>
                <tr>
                    <th>Nome</th>
                    <th>Email</th>
                    <th>Telefone</th>
                    <th>Plano</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    preview.forEach(item => {
        html += `
            <tr>
                <td>${item.name}</td>
                <td>${item.email}</td>
                <td>${item.phone}</td>
                <td>${item.plan}</td>
            </tr>
        `;
    });
    
    html += `</tbody></table>`;
    
    if (csvData.length > 5) {
        html += `<p style="margin-top: 10px; color: #718096;">... e mais ${csvData.length - 5} registros</p>`;
    }
    
    document.getElementById('previewTable').innerHTML = html;
    document.getElementById('importPreview').style.display = 'block';
    
    showAlert('importAlert', `${csvData.length} registros prontos para importar`, 'success');
}

async function processImport() {
    if (csvData.length === 0) {
        showAlert('importAlert', 'Nenhum dado para importar', 'error');
        return;
    }
    
    const btn = document.getElementById('importBtn');
    btn.disabled = true;
    btn.textContent = 'Importando...';
    
    try {
        const result = await apiRequest('/subscribers/import', 'POST', {
            subscribers: csvData
        });
        
        // Mostra resultados
        const { results } = result;
        
        let html = `
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px;">
                <div style="background: #c6f6d5; padding: 15px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: #22543d;">${results.success}</div>
                    <div style="color: #22543d;">Sucesso</div>
                </div>
                <div style="background: #fed7d7; padding: 15px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: #742a2a;">${results.errors}</div>
                    <div style="color: #742a2a;">Erros</div>
                </div>
                <div style="background: #feebc8; padding: 15px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: #744210;">${results.skipped}</div>
                    <div style="color: #744210;">Ignorados</div>
                </div>
            </div>
        `;
        
        // Detalhes dos erros/skipped
        const problems = results.details.filter(d => d.status === 'error' || d.status === 'skipped');
        
        if (problems.length > 0) {
            html += '<h4>Detalhes:</h4><ul style="margin-left: 20px;">';
            problems.forEach(p => {
                html += `<li>${p.email}: ${p.reason}</li>`;
            });
            html += '</ul>';
        }
        
        document.getElementById('resultsContent').innerHTML = html;
        document.getElementById('importResults').style.display = 'block';
        document.getElementById('importPreview').style.display = 'none';
        
        // Recarrega lista
        loadSubscribers();
        loadStats();
        
        showAlert('importAlert', 'Importação concluída!', 'success');
        
    } catch (error) {
        showAlert('importAlert', 'Erro ao importar: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Importar';
    }
}
// ============== SINCRONIZAÇÃO ==============

async function syncUsers() {
    const btn = document.getElementById('syncBtn');
    const alert = document.getElementById('syncAlert');
    
    if (!confirm('Tem certeza que deseja sincronizar?\n\nIsso vai remover TODOS os usuários inativos dos grupos do Telegram.')) {
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = '⏳ Sincronizando...';
    alert.classList.remove('show');
    
    try {
        const result = await apiRequest('/sync', 'POST');
        
        if (result.success) {
            if (result.removed > 0) {
                alert.className = 'alert alert-success show';
                alert.innerHTML = `
                    ✅ ${result.message}<br>
                    <strong>Usuários removidos:</strong> ${result.removed}
                `;
            } else {
                alert.className = 'alert show';
                alert.style.background = '#e6f7ff';
                alert.style.color = '#0066cc';
                alert.style.border = '1px solid #91d5ff';
                alert.textContent = 'ℹ️ ' + result.message;
            }
            
            // Atualiza estatísticas
            loadStats();
            loadSubscribers();
            loadLogs();
        } else {
            throw new Error(result.error || 'Erro desconhecido');
        }
        
    } catch (error) {
        alert.className = 'alert alert-error show';
        alert.textContent = '❌ Erro ao sincronizar: ' + error.message;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🔄 Sincronizar Agora';
    }
}