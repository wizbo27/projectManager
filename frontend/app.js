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

function showNewJobModal() { loadCustomers(); new bootstrap.Modal(document.getElementById('newJobModal')).show(); }
async function createNewJob() {
    const title = document.getElementById('newJobTitle').value, date = document.getElementById('newJobDate').value, customerName = document.getElementById('jobCustomerSelect').value;
    await apiFetch('/jobs', { method: 'POST', body: JSON.stringify({ title, date, customerName }) });
    bootstrap.Modal.getInstance(document.getElementById('newJobModal')).hide(); loadJobs();
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
    document.getElementById('jobLineItems').innerHTML = job.lines.map(l => `<tr><td>${l.description}</td><td>${l.type}</td><td>${l.quantity}</td><td>$${l.cost}</td></tr>`).join('');
    const total = job.lines.reduce((sum, l) => sum + (l.cost * l.quantity), 0);
    document.getElementById('jobStatusInfo').innerHTML = `
        <div class="text-center mb-4"><h3 class="fw-bold">$${total.toFixed(2)}</h3><span class="badge ${job.status === 'INVOICE' ? 'bg-success' : 'bg-warning'} p-2 px-3">${job.status}</span></div>
        ${job.status === 'ESTIMATE' ? `<button class="btn btn-success w-100 fw-bold" onclick="convertToInvoice('${id}')">CONVERT TO INVOICE</button>` : `<p class="text-center text-success fw-bold"><i class="fas fa-check-circle me-2"></i>Invoice Finalized</p>`}`;
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
