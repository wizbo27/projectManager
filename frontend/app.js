const API_URL = "https://8uig57n5j2.execute-api.us-east-1.amazonaws.com";
const COGNITO_DATA = { UserPoolId: 'us-east-1_rxiAtDAaX', ClientId: '3jmiu7s9bhnd8huopdb2ur4r3a' };
const userPool = new AmazonCognitoIdentity.CognitoUserPool(COGNITO_DATA);

let currentSession = null, allJobs = [], allCustomers = [], activeJobId = null, conversationHistory = [];
let activeJobsView = 'list';
let calendar = null;

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
    
    if (activeJobsView === 'calendar') {
        initCalendar();
    }
}

function showNewJobModal() { 
    document.getElementById('newJobTitle').value = '';
    document.getElementById('newJobDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('newJobEndDate').value = '';
    loadCustomers(); 
    new bootstrap.Modal(document.getElementById('newJobModal')).show(); 
}

async function createNewJob() {
    const title = document.getElementById('newJobTitle').value;
    const date = document.getElementById('newJobDate').value;
    const endDate = document.getElementById('newJobEndDate').value;
    const customerName = document.getElementById('jobCustomerInput').value;
    if (!title || !date) return alert('Please fill in title and date');
    await apiFetch('/jobs', { method: 'POST', body: JSON.stringify({ title, date, endDate, customerName }) });
    bootstrap.Modal.getInstance(document.getElementById('newJobModal')).hide(); loadJobs();
}

function editJob(id) {
    const job = allJobs.find(j => j.id === id);
    if (!job) return;
    
    document.getElementById('editJobId').value = id;
    document.getElementById('editJobTitle').value = job.title;
    document.getElementById('editJobDate').value = job.date;
    document.getElementById('editJobEndDate').value = job.endDate || '';
    document.getElementById('editJobCustomerInput').value = job.customerName || '';
    
    new bootstrap.Modal(document.getElementById('editJobModal')).show();
}

async function submitJobUpdate() {
    const id = document.getElementById('editJobId').value;
    const body = {
        title: document.getElementById('editJobTitle').value,
        date: document.getElementById('editJobDate').value,
        endDate: document.getElementById('editJobEndDate').value,
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
    renderVisitsList(job);
    
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

    // Reset history section to collapsed by default
    const collapseEl = document.getElementById('jobHistoryCollapse');
    if (collapseEl && collapseEl.classList.contains('show')) {
        collapseEl.classList.remove('show');
        const header = document.querySelector('[data-bs-target="#jobHistoryCollapse"]');
        header?.classList.add('collapsed');
        header?.setAttribute('aria-expanded', 'false');
    }
    loadJobHistory(id);
}

async function loadJobHistory(jobId) {
    const list = document.getElementById('jobHistoryList');
    list.innerHTML = '<tr><td colspan="3" class="text-center py-3"><div class="spinner-border spinner-border-sm text-secondary"></div></td></tr>';
    
    const collapseEl = document.getElementById('jobHistoryCollapse');
    if (collapseEl && !collapseEl.classList.contains('show')) {
        const header = document.querySelector('[data-bs-target="#jobHistoryCollapse"]');
        header?.classList.add('collapsed');
    }

    try {
        const history = await apiFetch(`/jobs/${jobId}/history`);
        if (!history || history.length === 0) {
            list.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-3">No history events.</td></tr>';
            return;
        }
        list.innerHTML = history.map(item => {
            const date = new Date(item.Timestamp).toLocaleString();
            let badgeClass = 'bg-secondary';
            if (item.ChangeType === 'CREATED') badgeClass = 'bg-success';
            else if (item.ChangeType === 'STATUS_CHANGE') badgeClass = 'bg-info text-dark';
            else if (item.ChangeType === 'LINE_ITEM_ADDED') badgeClass = 'bg-primary';
            else if (item.ChangeType === 'LINE_ITEM_DELETED') badgeClass = 'bg-danger';
            else if (item.ChangeType === 'LINE_ITEMS_BULK_UPDATE') badgeClass = 'bg-warning text-dark';
            else if (item.ChangeType === 'UPDATED') badgeClass = 'bg-dark';
            
            return `
                <tr>
                    <td><small class="text-muted">${date}</small></td>
                    <td><span class="badge ${badgeClass} text-uppercase" style="font-size: 0.7rem;">${item.ChangeType.replace(/_/g, ' ')}</span></td>
                    <td><small>${item.Description}</small></td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        list.innerHTML = '<tr><td colspan="3" class="text-center text-danger py-3">Failed to load history.</td></tr>';
    }
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

function switchJobsView(view) {
    activeJobsView = view;
    const btnList = document.getElementById('btnListView');
    const btnCal = document.getElementById('btnCalendarView');
    const listDiv = document.getElementById('jobsList');
    const calDiv = document.getElementById('calendarContainer');
    
    if (view === 'list') {
        btnList.classList.add('active');
        btnCal.classList.remove('active');
        listDiv.classList.remove('d-none');
        calDiv.classList.add('d-none');
    } else {
        btnList.classList.remove('active');
        btnCal.classList.add('active');
        listDiv.classList.add('d-none');
        calDiv.classList.remove('d-none');
        initCalendar();
    }
}

function initCalendar() {
    const calendarEl = document.getElementById('jobsCalendar');
    if (!calendarEl) return;
    
    if (calendar) {
        calendar.destroy();
    }
    
    const events = [];
    
    allJobs.forEach(job => {
        // Skip jobs with no valid start date
        if (!job.date) return;

        let startStr = job.date;
        // Use endDate if set and non-empty, otherwise fall back to startDate
        let endStr = (job.endDate && job.endDate.trim()) ? job.endDate : job.date;

        // Add 1 day to end date to make it inclusive in FullCalendar allDay view
        let endDateObj = new Date(endStr + 'T00:00:00');
        if (isNaN(endDateObj.getTime())) {
            endDateObj = new Date(startStr + 'T00:00:00');
        }
        endDateObj.setDate(endDateObj.getDate() + 1);
        let calEndStr = endDateObj.toISOString().split('T')[0];

        events.push({
            id: job.id,
            title: (job.title || 'Untitled') + (job.customerName ? ` (${job.customerName})` : ''),
            start: startStr,
            end: calEndStr,
            allDay: true,
            color: getStatusColor(job.status),
            extendedProps: {
                status: job.status,
                customer: job.customerName
            }
        });

        // Site visit events for this job
        if (job.visits && Array.isArray(job.visits)) {
            job.visits.forEach(visit => {
                // Skip visits with missing or invalid datetimes
                if (!visit.startDateTime || !visit.endDateTime) return;
                const visitStart = new Date(visit.startDateTime);
                const visitEnd = new Date(visit.endDateTime);
                if (isNaN(visitStart.getTime()) || isNaN(visitEnd.getTime())) return;

                events.push({
                    id: `visit-${visit.id}`,
                    title: `📌 Visit: ${job.title || 'Job'} ${visit.notes ? `(${visit.notes})` : ''}`,
                    start: visit.startDateTime,
                    end: visit.endDateTime,
                    color: '#6f42c1', // Purple for site visits
                    extendedProps: {
                        isVisit: true,
                        jobId: job.id,
                        notes: visit.notes
                    }
                });
            });
        }
    });

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay'
        },
        events: events,
        eventClick: function(info) {
            if (info.event.extendedProps.isVisit) {
                viewJob(info.event.extendedProps.jobId);
            } else {
                viewJob(info.event.id);
            }
        },
        themeSystem: 'bootstrap5'
    });
    calendar.render();
}

function getStatusColor(status) {
    const colors = {
        'ESTIMATE': '#ffc107',
        'APPROVED': '#0dcaf0',
        'IN PROGRESS': '#0d6efd',
        'INVOICED': '#198754',
        'PAID': '#212529'
    };
    return colors[status] || '#6c757d';
}

function showNewVisitModal() {
    document.getElementById('visitStart').value = '';
    document.getElementById('visitEnd').value = '';
    document.getElementById('visitNotes').value = '';
    new bootstrap.Modal(document.getElementById('newVisitModal')).show();
}

async function createNewVisit() {
    const startDateTime = document.getElementById('visitStart').value;
    const endDateTime = document.getElementById('visitEnd').value;
    const notes = document.getElementById('visitNotes').value;
    
    if (!startDateTime || !endDateTime) {
        return alert('Please enter both start and end date and time');
    }
    
    if (new Date(startDateTime) >= new Date(endDateTime)) {
        return alert('Start time must be before end time');
    }
    
    try {
        await apiFetch(`/jobs/${activeJobId}/visits`, {
            method: 'POST',
            body: JSON.stringify({ startDateTime, endDateTime, notes })
        });
        bootstrap.Modal.getInstance(document.getElementById('newVisitModal')).hide();
        await loadJobs();
        viewJob(activeJobId);
        showToast('Success', 'Site visit scheduled successfully');
    } catch (err) {
        showToast('Error', 'Failed to schedule site visit');
    }
}

async function deleteVisit(visitId) {
    if (!confirm('Are you sure you want to delete this site visit?')) return;
    try {
        await apiFetch(`/jobs/${activeJobId}/visits/${visitId}`, { method: 'DELETE' });
        await loadJobs();
        viewJob(activeJobId);
        showToast('Success', 'Site visit deleted');
    } catch (err) {
        showToast('Error', 'Failed to delete site visit');
    }
}

function renderVisitsList(job) {
    const visitList = document.getElementById('visitList');
    if (!visitList) return;
    
    const visits = job.visits || [];
    if (visits.length === 0) {
        visitList.innerHTML = '<div class="text-center py-4 text-muted small"><i class="far fa-calendar-times me-2"></i>No scheduled visits.</div>';
        return;
    }
    
    // Sort visits by start time
    visits.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));
    
    visitList.innerHTML = visits.map(v => {
        const start = new Date(v.startDateTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        const end = new Date(v.endDateTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        return `
            <div class="list-group-item px-0 py-2 d-flex justify-content-between align-items-start bg-transparent">
                <div class="flex-grow-1">
                    <div class="fw-bold text-dark small"><i class="far fa-clock me-1 text-info"></i> ${start} - ${end}</div>
                    ${v.notes ? `<div class="text-muted small mt-1 bg-light p-2 rounded border-start border-info border-3" style="font-size: 0.8rem; white-space: pre-wrap;">${v.notes}</div>` : ''}
                </div>
                <button class="btn btn-link text-danger btn-sm p-0 ms-2" onclick="deleteVisit('${v.id}')"><i class="fas fa-trash-alt"></i></button>
            </div>
        `;
    }).join('');
}
