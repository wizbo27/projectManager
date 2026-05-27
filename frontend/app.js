const API_URL = "https://8uig57n5j2.execute-api.us-east-1.amazonaws.com";
const COGNITO_DATA = { UserPoolId: 'us-east-1_rxiAtDAaX', ClientId: '3jmiu7s9bhnd8huopdb2ur4r3a' };
const userPool = new AmazonCognitoIdentity.CognitoUserPool(COGNITO_DATA);

let currentSession = null, allJobs = [], allCustomers = [], activeJobId = null, conversationHistory = [];

// --- DOM elements setup ---
const authView = document.getElementById('authView'), appView = document.getElementById('appView'), chatWindow = document.getElementById('chatWindow'), userInput = document.getElementById('userInput');

function setupStaticListeners() {
    document.getElementById('doLogin').onclick = () => {
        const email = document.getElementById('loginEmail').value, pass = document.getElementById('loginPass').value;
        const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({ Username: email, Password: pass });
        const cognitoUser = new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool });
        cognitoUser.authenticateUser(authDetails, {
            onSuccess: (result) => { currentSession = result; authView.classList.add('d-none'); appView.classList.remove('d-none'); showView('menu'); },
            onFailure: (err) => alert(err.message)
        });
    };

    document.getElementById('showRegister').onclick = () => {
        document.getElementById('loginForm').classList.add('d-none');
        document.getElementById('registerForm').classList.remove('d-none');
    };

    document.getElementById('showLogin').onclick = () => {
        document.getElementById('registerForm').classList.add('d-none');
        document.getElementById('loginForm').classList.remove('d-none');
    };

    document.getElementById('doRegister').onclick = () => {
        const email = document.getElementById('regEmail').value, pass = document.getElementById('regPass').value;
        userPool.signUp(email, pass, [], null, (err, result) => {
            if (err) return alert(err.message);
            alert('Registration successful!');
            document.getElementById('showLogin').click();
        });
    };

    document.getElementById('sendBtn').onclick = sendChatMessage;
    userInput.onkeypress = (e) => { if(e.key === 'Enter') sendChatMessage(); };
    document.getElementById('saveSettings').onclick = saveSettings;

    // Customer Autocomplete Search
    const customerInputs = [
        { inputId: 'jobCustomerInput', resultsId: 'jobCustomerResults' },
        { inputId: 'editJobCustomerInput', resultsId: 'editJobCustomerResults' }
    ];
    customerInputs.forEach(({ inputId, resultsId }) => {
        const el = document.getElementById(inputId);
        const resultsEl = document.getElementById(resultsId);
        if (el && resultsEl) {
            let timeout = null;
            el.oninput = (e) => {
                clearTimeout(timeout);
                timeout = setTimeout(async () => {
                    const query = e.target.value.trim();
                    if (query.length < 2) {
                        resultsEl.classList.remove('show');
                        return;
                    }
                    try {
                        const results = await apiFetch(`/customers?q=${encodeURIComponent(query)}`);
                        resultsEl.innerHTML = results.length 
                            ? results.map(c => `<button class="dropdown-item" onclick="selectCustomer('${inputId}', '${c.name}')">${c.name}</button>`).join('')
                            : '<div class="dropdown-item text-muted">No customers found</div>';
                        resultsEl.classList.add('show');
                    } catch (err) {
                        console.error('Search error:', err);
                    }
                }, 300);
            };
            
            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!el.contains(e.target) && !resultsEl.contains(e.target)) {
                    resultsEl.classList.remove('show');
                }
            });
        }
    });
}

function selectCustomer(inputId, name) {
    const el = document.getElementById(inputId);
    el.value = name;
    const resultsId = inputId === 'jobCustomerInput' ? 'jobCustomerResults' : 'editJobCustomerResults';
    document.getElementById(resultsId).classList.remove('show');
}

function showView(view) {
    document.querySelectorAll('.view-content').forEach(v => v.classList.add('d-none'));
    const target = document.getElementById(view + 'Content');
    if (target) target.classList.remove('d-none');
    if (view === 'menu') loadJobs();
    if (view === 'customers') loadCustomers();
    if (view === 'settings') loadSettings();
}

function logout() { userPool.getCurrentUser()?.signOut(); location.reload(); }

function showToast(title, body) {
    document.getElementById('toastTitle').innerText = title;
    document.getElementById('toastBody').innerText = body;
    new bootstrap.Toast(document.getElementById('liveToast')).show();
}

async function apiFetch(path, options = {}) {
    try {
        const token = currentSession.getIdToken().getJwtToken();
        const res = await fetch(API_URL + path, {
            ...options,
            headers: { 'Authorization': token, 'Content-Type': 'application/json', ...options.headers }
        });
        if (!res.ok) throw new Error('HTTP Error: ' + res.status);
        return await res.json();
    } catch (err) {
        showToast('Error', err.message);
        throw err;
    }
}

async function loadCustomers() {
    allCustomers = await apiFetch('/customers');
    const list = document.getElementById('customerList');
    list.innerHTML = allCustomers.map(c => `
        <div class="list-group-item d-flex justify-content-between align-items-center">
            <div><strong>${c.name}</strong><br><small>${c.email || ''} | ${c.phone || ''}</small></div>
            <div>
                <button class="btn btn-sm btn-outline-primary" onclick="editCustomer('${c.id}')">Edit</button>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteCustomer('${c.id}')">Delete</button>
            </div>
        </div>`).join('');
    
    const select = document.getElementById('jobCustomerSelect');
    select.innerHTML = '<option value="">None</option>' + allCustomers.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
}

async function deleteCustomer(id) {
    if (!confirm('Are you sure?')) return;
    const res = await apiFetch('/customers?id=' + id, { method: 'DELETE' });
    if (res.message.includes('Cannot delete')) alert(res.message);
    else loadCustomers();
}

function editCustomer(id) {
    const cust = allCustomers.find(c => c.id === id);
    document.getElementById('custName').value = cust.name;
    document.getElementById('custEmail').value = cust.email || '';
    document.getElementById('custPhone').value = cust.phone || '';
    document.getElementById('custAddress').value = cust.address || '';
    document.getElementById('custId').value = id;
    new bootstrap.Modal(document.getElementById('newCustomerModal')).show();
}

function showNewCustomerModal() {
    document.getElementById('custId').value = '';
    document.getElementById('custName').value = '';
    document.getElementById('custEmail').value = '';
    document.getElementById('custPhone').value = '';
    document.getElementById('custAddress').value = '';
    new bootstrap.Modal(document.getElementById('newCustomerModal')).show();
}

async function createCustomer() {
    const id = document.getElementById('custId').value;
    const body = { name: document.getElementById('custName').value, email: document.getElementById('custEmail').value, phone: document.getElementById('custPhone').value, address: document.getElementById('custAddress').value };
    if (id) body.id = id;
    await apiFetch('/customers', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    bootstrap.Modal.getInstance(document.getElementById('newCustomerModal')).hide(); loadCustomers();
}

async function loadJobs() {
    const list = document.getElementById('jobsList');
    list.innerHTML = '<div class="text-center w-100 py-5"><div class="spinner-border"></div></div>';
    allJobs = await apiFetch('/jobs');
    list.innerHTML = allJobs.length ? allJobs.map(job => `
        <div class="col-md-6 col-lg-4">
            <div class="card border-0 shadow-sm h-100 cursor-pointer" onclick="viewJob('${job.id}')">
                <div class="card-body">
                    <div class="d-flex justify-content-between mb-2"><h5 class="fw-bold text-primary mb-0">${job.title}</h5><span class="badge bg-light text-primary">${job.date}</span></div>
                    <p class="small text-muted mb-1"><i class="fas fa-user me-2"></i>${job.customerName || 'No Customer'}</p>
                    <span class="badge ${job.status === 'INVOICE' ? 'bg-success' : 'bg-warning'}">${job.status}</span>
                </div>
            </div>
        </div>
    `).join('') : '<div class="text-center w-100 py-5 text-muted">No jobs yet.</div>';
}

function showNewJobModal() { 
    document.getElementById('newJobTitle').value = '';
    document.getElementById('newJobDate').value = new Date().toISOString().split('T')[0];
    loadCustomers(); 
    new bootstrap.Modal(document.getElementById('newJobModal')).show(); 
}

async function createNewJob() {
    const title = document.getElementById('newJobTitle').value, date = document.getElementById('newJobDate').value, customerName = document.getElementById('jobCustomerInput').value;
    if (!title || !date) return alert('Please fill in title and date');
    await apiFetch('/jobs', { method: 'POST', body: JSON.stringify({ title, date, customerName }) });
    bootstrap.Modal.getInstance(document.getElementById('newJobModal')).hide(); loadJobs();
}

function editJob(id) {
    const job = allJobs.find(j => j.id === id);
    if (!job) return;
    
    document.getElementById('editJobId').value = id;
    document.getElementById('editJobTitle').value = job.title;
    document.getElementById('editJobDate').value = job.date;
    document.getElementById('editJobCustomerInput').value = job.customerName || '';
    
    new bootstrap.Modal(document.getElementById('editJobModal')).show();
}

async function submitJobUpdate() {
    const id = document.getElementById('editJobId').value;
    const body = {
        title: document.getElementById('editJobTitle').value,
        date: document.getElementById('editJobDate').value,
        customerName: document.getElementById('editJobCustomerInput').value
    };
    try {
        await apiFetch('/jobs/' + id, { method: 'PATCH', body: JSON.stringify(body) });
        bootstrap.Modal.getInstance(document.getElementById('editJobModal')).hide();
        await loadJobs();
        viewJob(id);
        showToast('Success', 'Job updated successfully');
    } catch (err) {
        showToast('Error', 'Failed to update job');
    }
}

function lookupAddress() {
    const addr = document.getElementById('custAddress').value;
    if (!addr) return alert('Enter an address to search');
    // Placeholder for address lookup logic
    showToast('Address Lookup', 'Searching for: ' + addr);
}

document.getElementById('importContact').onchange = (e) => {
    const file = e.target.files[0];
    if (file) showToast('Import', 'Importing contact from ' + file.name);
};

let isEditingItems = false;

function toggleItemsEdit() {
    isEditingItems = !isEditingItems;
    const btn = document.getElementById('toggleEditItems');
    btn.innerHTML = isEditingItems ? '<i class="fas fa-save me-1"></i> Save Items' : '<i class="fas fa-edit me-1"></i> Edit Items';
    btn.className = isEditingItems ? 'btn btn-sm btn-success' : 'btn btn-sm btn-outline-secondary';
    renderLineItems();
}

function renderLineItems() {
    const job = allJobs.find(j => j.id === activeJobId);
    if (!job) return;
    const tbody = document.getElementById('jobLineItems');
    
    if (isEditingItems) {
        tbody.innerHTML = job.lines.map((l, idx) => `
            <tr>
                <td><input type="text" class="form-control form-control-sm edit-desc" value="${l.description}"></td>
                <td>
                    <select class="form-select form-select-sm edit-type">
                        <option value="labor" ${l.type === 'labor' ? 'selected' : ''}>Labor</option>
                        <option value="material" ${l.type === 'material' ? 'selected' : ''}>Material</option>
                    </select>
                </td>
                <td><input type="number" class="form-control form-control-sm edit-qty" value="${l.quantity}"></td>
                <td><input type="number" class="form-control form-control-sm edit-cost" value="${l.cost}"></td>
                <td><button class="btn btn-sm btn-outline-danger" onclick="deleteLineItem(${idx})"><i class="fas fa-trash"></i></button></td>
            </tr>
        `).join('') + `
            <tr>
                <td colspan="5" class="text-center py-2">
                    <button class="btn btn-sm btn-outline-primary" onclick="addNewItemRow()">
                        <i class="fas fa-plus me-1"></i> Add Item
                    </button>
                </td>
            </tr>`;
        
        document.getElementById('toggleEditItems').onclick = saveBulkLineItems;
    } else {
        tbody.innerHTML = job.lines.map(l => `<tr><td>${l.description}</td><td>${l.type}</td><td>${l.quantity}</td><td>$${l.cost}</td></tr>`).join('');
        document.getElementById('toggleEditItems').onclick = toggleItemsEdit;
    }
}

async function deleteLineItem(idOrIdx) {
    if (isEditingItems) {
        // Local delete from state
        const job = allJobs.find(j => j.id === activeJobId);
        job.lines.splice(idOrIdx, 1);
        renderLineItems();
    } else {
        // API delete
        try {
            await apiFetch(`/jobs/${activeJobId}/items/${idOrIdx}`, { method: 'DELETE' });
            await loadJobs();
            viewJob(activeJobId);
            showToast('Success', 'Item deleted');
        } catch (err) {
            showToast('Error', 'Failed to delete item');
        }
    }
}

function syncItemsState() {
    const job = allJobs.find(j => j.id === activeJobId);
    if (!job || !isEditingItems) return;
    const rows = document.querySelectorAll('#jobLineItems tr');
    job.lines = Array.from(rows)
        .filter(row => row.querySelector('.edit-desc'))
        .map(row => ({
            description: row.querySelector('.edit-desc').value,
            type: row.querySelector('.edit-type').value,
            quantity: parseFloat(row.querySelector('.edit-qty').value) || 0,
            cost: parseFloat(row.querySelector('.edit-cost').value) || 0
        }));
}

function addNewItemRow() {
    syncItemsState();
    const job = allJobs.find(j => j.id === activeJobId);
    if (!job) return;
    job.lines.push({ description: '', type: 'labor', quantity: 1, cost: 0 });
    renderLineItems();
}

async function saveBulkLineItems() {
    syncItemsState();
    const job = allJobs.find(j => j.id === activeJobId);
    if (!job) return;

    try {
        await apiFetch(`/jobs/${activeJobId}/items/bulk`, { 
            method: 'POST', 
            body: JSON.stringify({ lines: job.lines }) 
        });
        isEditingItems = false;
        document.getElementById('toggleEditItems').innerHTML = '<i class="fas fa-edit me-1"></i> Edit Items';
        document.getElementById('toggleEditItems').className = 'btn btn-sm btn-outline-secondary';
        document.getElementById('toggleEditItems').onclick = toggleItemsEdit;
        
        await loadJobs();
        viewJob(activeJobId);
        showToast('Success', 'Items updated successfully');
    } catch (err) {
        showToast('Error', 'Failed to update items');
    }
}

async function advanceStatus(id) {
    const job = allJobs.find(j => j.id === id);
    const statuses = ['ESTIMATE', 'APPROVED', 'IN PROGRESS', 'INVOICED', 'PAID'];
    const currentIndex = statuses.indexOf(job.status);
    if (currentIndex === -1 || currentIndex === statuses.length - 1) return;
    
    const nextStatus = statuses[currentIndex + 1];
    try {
        await apiFetch(`/jobs/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) });
        await loadJobs();
        viewJob(id);
        showToast('Success', `Job moved to ${nextStatus}`);
    } catch (err) {
        showToast('Error', 'Failed to update status');
    }
}

function getStatusBadgeClass(status) {
    const colors = {
        'ESTIMATE': 'bg-warning text-dark',
        'APPROVED': 'bg-info text-dark',
        'IN PROGRESS': 'bg-primary',
        'INVOICED': 'bg-success',
        'PAID': 'bg-dark'
    };
    return colors[status] || 'bg-secondary';
}

function viewJob(id) {
    activeJobId = id; const job = allJobs.find(j => j.id === id); if (!job) return;
    showView('jobDetail');
    document.getElementById('jobDetailHeader').innerHTML = `
        <div class="d-flex justify-content-between align-items-end border-bottom pb-3 mb-4">
            <div><h1 class="fw-bold text-primary mb-1">${job.title}</h1><p class="text-muted mb-0">Customer: <strong>${job.customerName || 'None'}</strong></p></div>
            <div>
                <button class="btn btn-outline-primary btn-sm me-2" onclick="editJob('${id}')">Edit</button>
                <button class="btn btn-outline-success btn-sm me-2" onclick="showAddItemModal('${id}')">Add Item</button>
                <button class="btn btn-primary btn-sm" onclick="chatWithJob('${id}')">Chat with Job</button>
            </div>
        </div>`;
    
    renderLineItems();
    
    const total = job.lines.reduce((sum, l) => sum + (l.cost * l.quantity), 0);
    const statuses = ['ESTIMATE', 'APPROVED', 'IN PROGRESS', 'INVOICED', 'PAID'];
    const currentIndex = statuses.indexOf(job.status);
    const nextStatus = currentIndex < statuses.length - 1 ? statuses[currentIndex + 1] : null;

    document.getElementById('jobStatusInfo').innerHTML = `
        <div class="text-center mb-4">
            <h3 class="fw-bold">$${total.toFixed(2)}</h3>
            <span class="badge ${getStatusBadgeClass(job.status)} p-2 px-3">${job.status}</span>
        </div>
        ${nextStatus ? `<button class="btn btn-primary w-100 fw-bold" onclick="advanceStatus('${id}')">MOVE TO ${nextStatus}</button>` : `<p class="text-center text-success fw-bold"><i class="fas fa-check-circle me-2"></i>Job Fully Paid</p>`}`;
}

window.chatWithJob = function(jobId) {
    activeJobId = jobId;
    conversationHistory = [];
    showView('chat');
    chatWindow.innerHTML = `<div class="assistant-msg mb-3 p-3 rounded shadow-sm">Chatting in context of job: ${jobId}. Ask me to add labor or materials!</div>`;
};

function showAddItemModal(jobId) {
    activeJobId = jobId;
    new bootstrap.Modal(document.getElementById('newItemModal')).show();
}

async function submitLineItem() {
    const body = {
        description: document.getElementById('itemDesc').value,
        type: document.getElementById('itemType').value,
        cost: parseFloat(document.getElementById('itemCost').value),
        quantity: parseFloat(document.getElementById('itemQty').value)
    };
    await apiFetch('/jobs/' + activeJobId + '/items', { method: 'POST', body: JSON.stringify(body) });
    bootstrap.Modal.getInstance(document.getElementById('newItemModal')).hide();
    allJobs = []; 
    loadJobs().then(() => viewJob(activeJobId));
}

async function convertToInvoice(id) {
    await apiFetch('/jobs/' + id + '/convert', { method: 'POST' });
    allJobs = await apiFetch('/jobs'); viewJob(id);
}

async function sendChatMessage() {
    const msg = userInput.value.trim(); if (!msg) return;
    addChatMessage(msg, 'user'); userInput.value = '';
    const res = await apiFetch('/chat', { method: 'POST', body: JSON.stringify({ message: msg, jobId: activeJobId, history: conversationHistory }) });
    conversationHistory = res.history;
    addChatMessage(res.message, 'assistant');
}

function addChatMessage(text, role) {
    const div = document.createElement('div'); div.className = `${role}-msg mb-3 p-3 rounded shadow-sm`;
    div.innerText = text; chatWindow.appendChild(div); chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function loadSettings() {
    const settings = await apiFetch('/settings');
    document.getElementById('businessId').value = settings.businessId || '';
}

async function saveSettings() {
    const waveToken = document.getElementById('waveToken').value, businessId = document.getElementById('businessId').value;
    await apiFetch('/settings', { method: 'POST', body: JSON.stringify({ waveToken, businessId }) });
    alert('Saved!');
}

window.onload = () => {
    setupStaticListeners();
    const user = userPool.getCurrentUser();
    if (user) { user.getSession((err, session) => { if (session?.isValid()) { currentSession = session; authView.classList.add('d-none'); appView.classList.remove('d-none'); showView('menu'); } }); }
};
