const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

module.exports = function(connectToDatabase) {
  const router = express.Router();

  // Middleware to check authentication and CSRF
  const requireAdmin = (req, res, next) => {
    try {
      const token = req.cookies.admin_token;
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      
      const secret = process.env.SESSION_SECRET || 'dev_fallback_secret_do_not_use_in_prod';
      const decoded = jwt.verify(token, secret);
      
      // CSRF check for mutations
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        const csrfHeader = req.headers['x-csrf-token'];
        if (!csrfHeader || csrfHeader !== decoded.csrfToken) {
          return res.status(403).json({ error: 'CSRF validation failed' });
        }
      }
      
      req.admin = decoded;
      next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid or expired session' });
    }
  };

  // --- ADMIN APIs ---
  
  router.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminEmail || !adminHash) {
      return res.status(500).json({ error: 'Server not configured for admin access.' });
    }

    if (email !== adminEmail || !bcrypt.compareSync(password, adminHash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const csrfToken = crypto.randomBytes(32).toString('hex');
    const secret = process.env.SESSION_SECRET || 'dev_fallback_secret_do_not_use_in_prod';
    
    const token = jwt.sign({ email, role: 'admin', csrfToken }, secret, { expiresIn: '4h' });
    
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 4 * 60 * 60 * 1000
    });

    res.json({ success: true, csrfToken });
  });

  router.post('/api/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.json({ success: true });
  });

  router.get('/api/me', requireAdmin, (req, res) => {
    res.json({ email: req.admin.email, csrfToken: req.admin.csrfToken });
  });

  router.get('/api/appointments', requireAdmin, async (req, res) => {
    try {
      const db = await connectToDatabase();
      const { status } = req.query;
      const query = status && status !== 'all' ? { status } : {};
      
      const appointments = await db.collection('appointments')
        .find(query)
        .sort({ appointmentDate: -1, timeSlot: 1 })
        .toArray();
        
      res.json(appointments);
    } catch (error) {
      res.status(500).json({ error: 'Failed to load appointments' });
    }
  });

  router.patch('/api/appointments/:id/status', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const allowedStatuses = ['pending', 'approved', 'rejected', 'completed', 'cancelled'];
      
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      const db = await connectToDatabase();
      const result = await db.collection('appointments').updateOne(
        { bookingReference: id },
        { $set: { status, updatedAt: new Date().toISOString() } }
      );

      if (result.matchedCount === 0) return res.status(404).json({ error: 'Appointment not found' });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Database update failed' });
    }
  });

  // --- ADMIN FRONTEND (Served from /admin) ---
  const adminHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dentora Admin Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    :root {
      --bg: #F4F7FF; --primary: #6478F7; --text: #26324A; --white: #FFFFFF;
      --clay-shadow: 8px 8px 16px rgba(100,120,247,0.08), -8px -8px 16px rgba(255,255,255,0.9);
      --status-pending: #F59E0B; --status-approved: #10B981; --status-rejected: #EF4444; 
      --status-completed: #3B82F6; --status-cancelled: #6B7280;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: var(--bg); color: var(--text); }
    .container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
    
    .clay-card { background: var(--white); border-radius: 20px; box-shadow: var(--clay-shadow); padding: 30px; }
    .clay-input { width: 100%; padding: 12px 16px; border-radius: 12px; border: none; background: var(--bg); box-shadow: inset 4px 4px 8px rgba(100,120,247,0.1), inset -4px -4px 8px rgba(255,255,255,0.9); margin: 8px 0 20px; outline: none; }
    .clay-btn { background: var(--primary); color: var(--white); border: none; padding: 12px 24px; border-radius: 12px; cursor: pointer; box-shadow: 4px 4px 10px rgba(100,120,247,0.2), -4px -4px 10px rgba(255,255,255,0.9); font-weight: 600; }
    
    /* Login */
    #login-view { height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-box { max-width: 400px; width: 100%; text-align: center; }
    
    /* Dashboard */
    #dashboard-view { display: none; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
    .stat-card { text-align: center; }
    .stat-card h3 { font-size: 32px; color: var(--primary); margin-top: 10px; }
    
    .table-container { overflow-x: auto; }
    table { width: 100%; border-collapse: separate; border-spacing: 0 10px; }
    th { text-align: left; padding: 10px 20px; color: #6B7280; font-weight: 600; font-size: 14px; }
    td { padding: 15px 20px; background: var(--white); }
    tr td:first-child { border-radius: 16px 0 0 16px; }
    tr td:last-child { border-radius: 0 16px 16px 0; }
    tr { box-shadow: var(--clay-shadow); }
    
    .badge { padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; color: white; text-transform: capitalize; }
    .badge.pending { background: var(--status-pending); }
    .badge.approved { background: var(--status-approved); }
    .badge.rejected { background: var(--status-rejected); }
    .badge.completed { background: var(--status-completed); }
    .badge.cancelled { background: var(--status-cancelled); }
    
    .action-select { padding: 6px 10px; border-radius: 8px; border: 1px solid #E5E7EB; background: var(--bg); cursor: pointer; outline: none; }
    
    #toast { position: fixed; bottom: 30px; right: 30px; background: var(--white); padding: 15px 25px; border-radius: 12px; box-shadow: var(--clay-shadow); opacity: 0; pointer-events: none; transition: 0.3s; z-index: 1000; }
  </style>
</head>
<body>

  <!-- LOGIN VIEW -->
  <div id="login-view">
    <div class="clay-card login-box">
      <h2 style="margin-bottom: 20px; color: var(--primary);"><i data-lucide="lock"></i> Admin Login</h2>
      <form id="login-form">
        <div style="text-align: left;"><label>Email</label></div>
        <input type="email" id="l-email" class="clay-input" required>
        <div style="text-align: left;"><label>Password</label></div>
        <input type="password" id="l-pass" class="clay-input" required>
        <button type="submit" class="clay-btn" style="width: 100%;">Secure Login</button>
      </form>
    </div>
  </div>

  <!-- DASHBOARD VIEW -->
  <div id="dashboard-view" class="container">
    <div class="header clay-card">
      <h2><i data-lucide="layout-dashboard"></i> Dentora Admin</h2>
      <div>
        <span id="admin-user" style="margin-right: 20px; font-weight: 500;"></span>
        <button onclick="logout()" class="clay-btn" style="background: var(--bg); color: var(--text);">Logout</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="clay-card stat-card"><div>Total</div><h3 id="st-total">-</h3></div>
      <div class="clay-card stat-card"><div>Pending</div><h3 id="st-pending" style="color: var(--status-pending);">-</h3></div>
      <div class="clay-card stat-card"><div>Approved (Upcoming)</div><h3 id="st-approved" style="color: var(--status-approved);">-</h3></div>
    </div>

    <div class="clay-card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h3>Appointments</h3>
        <select id="filter-status" class="action-select" style="padding: 10px;" onchange="loadAppointments()">
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="completed">Completed</option>
        </select>
      </div>
      
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Ref</th>
              <th>Patient</th>
              <th>Date & Time</th>
              <th>Service</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="apt-body">
            <tr><td colspan="6" style="text-align:center;">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    lucide.createIcons();
    let csrfToken = '';

    const showToast = (msg) => {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.opacity = '1';
      setTimeout(() => t.style.opacity = '0', 3000);
    };

    const escapeHTML = (str) => {
      if(!str) return '';
      return str.replace(/[&<>'"]/g, tag => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
      }[tag]));
    };

    // Check Auth on load
    fetch('/admin/api/me').then(r => {
      if(r.ok) return r.json();
      throw new Error('Not logged in');
    })
    .then(data => {
      csrfToken = data.csrfToken;
      document.getElementById('admin-user').innerText = data.email;
      showDashboard();
    })
    .catch(() => showLogin());

    function showLogin() {
      document.getElementById('login-view').style.display = 'flex';
      document.getElementById('dashboard-view').style.display = 'none';
    }

    function showDashboard() {
      document.getElementById('login-view').style.display = 'none';
      document.getElementById('dashboard-view').style.display = 'block';
      loadAppointments();
    }

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.innerText = 'Verifying...';
      
      const res = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('l-email').value,
          password: document.getElementById('l-pass').value
        })
      });
      
      if(res.ok) {
        const data = await res.json();
        csrfToken = data.csrfToken;
        document.getElementById('admin-user').innerText = document.getElementById('l-email').value;
        showDashboard();
      } else {
        showToast('Login Failed');
      }
      btn.innerText = 'Secure Login';
    });

    async function logout() {
      await fetch('/admin/api/logout', { method: 'POST' });
      location.reload();
    }

    async function loadAppointments() {
      const status = document.getElementById('filter-status').value;
      const res = await fetch('/admin/api/appointments?status=' + status);
      const data = await res.json();
      
      let html = '';
      let counts = { total: data.length, pending: 0, approved: 0 };
      
      data.forEach(apt => {
        if(apt.status === 'pending') counts.pending++;
        if(apt.status === 'approved') counts.approved++;
        
        const actionHtml = '<select class="action-select" onchange="updateStatus(\\'' + apt.bookingReference + '\\', this.value)">' +
          '<option disabled selected>Change Status</option>' +
          '<option value="approved">Approve</option>' +
          '<option value="rejected">Reject</option>' +
          '<option value="completed">Complete</option>' +
          '<option value="cancelled">Cancel</option>' +
          '</select>';

        html += '<tr>' +
          '<td><strong>' + escapeHTML(apt.bookingReference) + '</strong></td>' +
          '<td>' + escapeHTML(apt.patientName) + '<br><small>' + escapeHTML(apt.phone) + '</small></td>' +
          '<td>' + escapeHTML(apt.appointmentDate) + '<br><strong>' + escapeHTML(apt.timeSlot) + '</strong></td>' +
          '<td>' + escapeHTML(apt.service) + '</td>' +
          '<td><span class="badge ' + apt.status + '">' + apt.status + '</span></td>' +
          '<td>' + actionHtml + '</td>' +
          '</tr>';
      });

      document.getElementById('apt-body').innerHTML = html || '<tr><td colspan="6" style="text-align:center;">No appointments found.</td></tr>';
      
      if(status === 'all') {
        document.getElementById('st-total').innerText = counts.total;
        document.getElementById('st-pending').innerText = counts.pending;
        document.getElementById('st-approved').innerText = counts.approved;
      }
    }

    async function updateStatus(ref, newStatus) {
      if(!confirm('Change status of ' + ref + ' to ' + newStatus + '?')) return loadAppointments();
      
      const res = await fetch('/admin/api/appointments/' + ref + '/status', {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({ status: newStatus })
      });
      
      if(res.ok) {
        showToast('Updated ' + ref);
        loadAppointments();
      } else {
        showToast('Failed to update');
      }
    }
  </script>
</body>
</html>`;

  router.get('/', (req, res) => {
    res.send(adminHTML);
  });

  return router;
};
