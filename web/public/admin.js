// Configuração
const API_URL = 'https://telegram-auth-bot-production.up.railway.app/api/admin';
let authToken = localStorage.getItem('adminToken') || '';
let subscribersData = [];

// Verifica se já está logado
if (authToken) {
    showDashboard();
}

// ============== LOGIN ==============

// LOGIN
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const alert = document.getElementById('loginAlert');
    
    // Testa as credenciais fazendo uma requisição
    const credentials = `${username}:${password}`;
    
    try {
        const response = await fetch(`${API_URL}/stats`, {
            headers: {
                'Authorization': `Bearer ${credentials}`
            }
        });
        
        if (response.ok) {
            authToken = credentials;
            localStorage.setItem('adminToken', credentials);
            localStorage.setItem('adminUser', username);
            showDashboard();
        } else {
            alert.textContent = '❌ Usuário ou senha incorretos!';
            alert.classList.add('show');
            setTimeout(() => alert.classList.remove('show'), 3000);
        }
    } catch (error) {
        alert.textContent = '❌ Erro ao conectar ao servidor';
        alert.classList.add('show');
    }
});

const subscriberSearchInput = document.getElementById('subscriberSearch');
if (subscriberSearchInput) {
    subscriberSearchInput.addEventListener('input', (event) => {
        renderSubscribersTable(event.target.value);
    });
}

function logout() {
    localStorage.removeItem('adminToken');
    authToken = '';
    document.getElementById('loginContainer').style.display = 'flex';
    document.getElementById('dashboard').classList.remove('active');
}

function showDashboard() {
    const username = localStorage.getItem('adminUser') || 'Admin';
    document.getElementById('loggedUser').textContent = username;
    document.getElementById('loginContainer').style.display = 'none';
    document.getElementById('dashboard').classList.add('active');
    loadStats();
    loadSubscribers();
    loadChannels();
    loadLogs();
    loadAdminUsers();
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
    const contentType = response.headers.get('content-type') || '';
    let data = null;

    if (contentType.includes('application/json')) {
        data = await response.json();
    } else {
        const text = await response.text();
        data = text ? text : null;
    }

    if (!response.ok) {
        const message = data && data.error ? data.error : (typeof data === 'string' && data ? data : 'Erro na requisição');
        throw new Error(message);
    }

    return data;
}

function escapeHtml(value) {
    if (value === null || value === undefined) {
        return '';
    }

    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ============== TABS ==============

function showTab(tabName, trigger = null) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    const tabButton = trigger || document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (tabButton) {
        tabButton.classList.add('active');
    }

    const tabContent = document.getElementById(`${tabName}Tab`);
    if (tabContent) {
        tabContent.classList.add('active');
    }
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
        subscribersData = await apiRequest('/subscribers');
        const searchValue = subscriberSearchInput ? subscriberSearchInput.value : '';
        renderSubscribersTable(searchValue);
    } catch (error) {
        console.error('Erro ao carregar assinantes:', error);
    }
}

function renderSubscribersTable(filter = '') {
    const tableContainer = document.getElementById('subscribersTable');
    if (!tableContainer) {
        return;
    }

    const normalizedFilter = filter.trim().toLowerCase();
    const filteredSubscribers = normalizedFilter
        ? subscribersData.filter((subscriber) => {
            const valuesToSearch = [
                subscriber.name,
                subscriber.email,
                subscriber.phone,
                subscriber.plan,
                subscriber.status
            ];

            return valuesToSearch.some((value) =>
                value && String(value).toLowerCase().includes(normalizedFilter)
            );
        })
        : subscribersData;

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

    if (filteredSubscribers.length === 0) {
        html += `
            <tr>
                <td colspan="7" class="empty-state">Nenhum assinante encontrado.</td>
            </tr>
        `;
    } else {
        filteredSubscribers.forEach(sub => {
            const statusBadge = sub.status === 'active' ? 'badge-success' : 'badge-danger';
            const statusText = sub.status === 'active' ? 'Ativo' : 'Inativo';
            const hasAuth = sub.authorized ? 'badge-success' : 'badge-warning';
            const authText = sub.authorized ? 'Autorizado' : 'Pendente';

            html += `
                <tr>
                    <td data-label="Nome">${sub.name}</td>
                    <td data-label="Email">${sub.email}</td>
                    <td data-label="Telefone">${sub.phone}</td>
                    <td data-label="Plano">${sub.plan}</td>
                    <td data-label="Status"><span class="badge ${statusBadge}">${statusText}</span></td>
                    <td data-label="Telegram"><span class="badge ${hasAuth}">${authText}</span></td>
                    <td class="actions" data-label="Ações">
                        <button class="btn-small btn-edit" onclick="editSubscriber(${sub.id})">Editar</button>
                        <button class="btn-small btn-delete" onclick="deleteSubscriber(${sub.id}, '${sub.name}')">Remover</button>
                    </td>
                </tr>
            `;
        });
    }

    html += '</tbody></table>';
    tableContainer.innerHTML = html;
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
                        <th>Status</th>
                        <th>Ações</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        channels.forEach(channel => {
            const statusBadge = channel.active ? 'badge-success' : 'badge-danger';
            const statusText = channel.active ? 'Ativo' : 'Inativo';
            
            html += `
                <tr>
                    <td data-label="Nome">${channel.name}</td>
                    <td data-label="Chat ID"><code>${channel.chat_id}</code></td>
                    <td data-label="Plano">${channel.plan}</td>
                    <td data-label="Ordem">${channel.order_index}</td>
                    <td data-label="Status"><span class="badge ${statusBadge}">${statusText}</span></td>
                    <td class="actions" data-label="Ações">
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
        active: document.getElementById('channelActive').value === 'true'
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
                    <td data-label="Data/Hora">${dateStr}</td>
                    <td data-label="Ação"><span class="badge ${actionBadge}">${actionText}</span></td>
                    <td data-label="Nome">${log.name || '-'}</td>
                    <td data-label="Email">${log.email || '-'}</td>
                    <td data-label="Telegram ID"><code>${log.telegram_id}</code></td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        document.getElementById('logsTable').innerHTML = html;
    } catch (error) {
        console.error('Erro ao carregar logs:', error);
    }
}

// ============== ADMINISTRADORES ==============

async function loadAdminUsers() {
    try {
        const admins = await apiRequest('/admins');

        if (!admins || admins.length === 0) {
            document.getElementById('adminsTable').innerHTML = '<p>Nenhum administrador cadastrado ainda.</p>';
            return;
        }

        let html = `
            <table>
                <thead>
                    <tr>
                        <th>Usuário</th>
                        <th>Criado em</th>
                        <th>Último acesso</th>
                        <th>Ações</th>
                    </tr>
                </thead>
                <tbody>
        `;

        admins.forEach(admin => {
            const created = admin.created_at ? new Date(admin.created_at).toLocaleString('pt-BR') : '-';
            const lastLogin = admin.last_login ? new Date(admin.last_login).toLocaleString('pt-BR') : '-';
            const safeUsername = escapeHtml(admin.username || '');
            const encodedUsername = encodeURIComponent(admin.username || '');

            html += `
                <tr>
                    <td data-label="Usuário">${safeUsername}</td>
                    <td data-label="Criado em">${created}</td>
                    <td data-label="Último acesso">${lastLogin}</td>
                    <td class="actions" data-label="Ações">
                        <button class="btn-small btn-edit" data-action="edit-admin" data-id="${admin.id}" data-username="${encodedUsername}">Atualizar senha</button>
                        <button class="btn-small btn-delete" data-action="delete-admin" data-id="${admin.id}" data-username="${encodedUsername}">Remover</button>
                    </td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        document.getElementById('adminsTable').innerHTML = html;
    } catch (error) {
        console.error('Erro ao carregar administradores:', error);
        showAlert('adminsAlert', 'Não foi possível carregar os administradores.', 'error');
    }
}

const adminsTableContainer = document.getElementById('adminsTable');
if (adminsTableContainer) {
    adminsTableContainer.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');

        if (!button) {
            return;
        }

        const action = button.dataset.action;
        const id = button.dataset.id;
        const username = decodeURIComponent(button.dataset.username || '');

        if (action === 'edit-admin') {
            openEditAdminModal(id, username);
        } else if (action === 'delete-admin') {
            deleteAdmin(id, username);
        }
    });
}

function openAddAdminModal() {
    document.getElementById('adminModalTitle').textContent = 'Novo Administrador';
    document.getElementById('adminForm').reset();
    document.getElementById('adminId').value = '';
    document.getElementById('adminUsername').disabled = false;
    document.getElementById('adminUsername').value = '';
    document.getElementById('adminPassword').value = '';
    document.getElementById('adminModalAlert').classList.remove('show');
    document.getElementById('adminModal').classList.add('active');
}

function openEditAdminModal(id, username) {
    document.getElementById('adminModalTitle').textContent = `Atualizar Senha - ${username}`;
    document.getElementById('adminForm').reset();
    document.getElementById('adminId').value = id;
    document.getElementById('adminUsername').value = username;
    document.getElementById('adminUsername').disabled = true;
    document.getElementById('adminPassword').value = '';
    document.getElementById('adminModalAlert').classList.remove('show');
    document.getElementById('adminModal').classList.add('active');
}

function closeAdminModal() {
    document.getElementById('adminModal').classList.remove('active');
    document.getElementById('adminForm').reset();
    document.getElementById('adminUsername').disabled = false;
}

const adminForm = document.getElementById('adminForm');
if (adminForm) {
    adminForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const id = document.getElementById('adminId').value;
        const username = document.getElementById('adminUsername').value.trim();
        const password = document.getElementById('adminPassword').value;

        if (!id && !username) {
            showAlert('adminModalAlert', 'Informe o nome de usuário.', 'error');
            return;
        }

        if (!password || password.length < 8) {
            showAlert('adminModalAlert', 'A senha deve ter pelo menos 8 caracteres.', 'error');
            return;
        }

        try {
            if (id) {
                await apiRequest(`/admins/${id}`, 'PUT', { password });
                showAlert('adminsAlert', 'Senha atualizada com sucesso!', 'success');
            } else {
                await apiRequest('/admins', 'POST', { username, password });
                showAlert('adminsAlert', 'Administrador criado com sucesso!', 'success');
            }

            closeAdminModal();
            loadAdminUsers();
            document.getElementById('adminForm').reset();
        } catch (error) {
            const message = error.message || 'Erro ao salvar administrador';
            showAlert('adminModalAlert', message, 'error');
        }
    });
}

async function deleteAdmin(id, username) {
    if (!confirm(`Deseja realmente remover o administrador ${username}?`)) {
        return;
    }

    try {
        await apiRequest(`/admins/${id}`, 'DELETE');
        loadAdminUsers();
        showAlert('adminsAlert', 'Administrador removido com sucesso.', 'success');
    } catch (error) {
        const message = error.message || 'Não foi possível remover o administrador.';
        showAlert('adminsAlert', message, 'error');
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
                    'Pedro Costa,pedro@email.com,11977777777,Close Friends LITE,active';
    
    const blob = new Blob([template], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'modelo_importacao.csv';
    link.click();
}

const csvInput = document.getElementById('csvFile');
if (csvInput) {
    csvInput.addEventListener('change', (e) => {
        const file = e.target.files[0];

        if (!file) return;

        const reader = new FileReader();

        reader.onload = (event) => {
            const text = event.target.result;
            parseCSV(text);
        };

        reader.readAsText(file);
    });
}

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
    alert.className = 'alert';
    alert.removeAttribute('style');
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