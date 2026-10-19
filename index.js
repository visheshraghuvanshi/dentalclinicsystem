const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// Support local development if .env is present (ignored in Vercel)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
app.set('trust proxy', 1);

// Security and utility middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com", "https://plus.unsplash.com"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// Rate Limiting
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const bookingLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many booking requests from this IP.' } });
app.use('/api/', publicLimiter);

// MongoDB Connection (Serverless Cached)
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  
  const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || 'dentora_dental');
  
  // Unique index to prevent double bookings purely at the database level.
  await db.collection('appointments').createIndex(
    { appointmentDate: 1, timeSlot: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved'] } } }
  );
  
  cachedDb = db;
  return db;
}

// Services Catalogue
const SERVICES = [
  { id: 'checkup', name: 'General Dental Checkup', price: '₹499' },
  { id: 'cleaning', name: 'Teeth Cleaning', price: '₹999' },
  { id: 'whitening', name: 'Teeth Whitening', price: '₹3,499' },
  { id: 'braces', name: 'Dental Braces Consultation', price: '₹799' },
  { id: 'rootcanal', name: 'Root Canal Consultation', price: '₹699' },
  { id: 'implants', name: 'Dental Implants Consultation', price: '₹999' },
  { id: 'pediatric', name: 'Pediatric Dentistry', price: '₹599' },
  { id: 'cosmetic', name: 'Cosmetic Dentistry', price: '₹899' }
];

// Mount Admin Router
const adminRouter = require('./admin')(connectToDatabase);
app.use('/admin', adminRouter);

// --- PUBLIC APIs ---

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/services', (req, res) => res.json(SERVICES));

app.get('/api/availability', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
    
    // Validate if it's Sunday (0)
    const dateObj = new Date(date);
    if (dateObj.getDay() === 0) return res.json({ availableSlots: [] });

    // Generate all clinic slots (9 AM to 6 PM)
    const allSlots = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    
    const db = await connectToDatabase();
    const booked = await db.collection('appointments').find(
      { appointmentDate: date, status: { $in: ['pending', 'approved'] } },
      { projection: { timeSlot: 1, _id: 0 } }
    ).toArray();
    
    const bookedSlots = booked.map(b => b.timeSlot);
    const availableSlots = allSlots.filter(slot => !bookedSlots.includes(slot));
    
    res.json({ availableSlots });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch availability.' });
  }
});

app.post('/api/appointments', bookingLimiter, async (req, res) => {
  try {
    const { patientName, email, phone, service, appointmentDate, timeSlot, message } = req.body;
    
    // Strict Validation
    if (!patientName || !email || !phone || !service || !appointmentDate || !timeSlot) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!SERVICES.find(s => s.id === service)) return res.status(400).json({ error: 'Invalid service.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) return res.status(400).json({ error: 'Invalid date.' });
    if (!/^\d{2}:\d{2}$/.test(timeSlot)) return res.status(400).json({ error: 'Invalid timeslot.' });
    
    const dateObj = new Date(appointmentDate);
    if (dateObj < new Date(new Date().setHours(0,0,0,0))) return res.status(400).json({ error: 'Date is in the past.' });
    if (dateObj.getDay() === 0) return res.status(400).json({ error: 'Clinic closed on Sundays.' });

    const bookingReference = 'DENT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const newAppointment = {
      bookingReference,
      patientName: String(patientName).trim(),
      email: String(email).trim().toLowerCase(),
      phone: String(phone).trim(),
      service,
      appointmentDate,
      timeSlot,
      message: message ? String(message).trim().substring(0, 500) : '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const db = await connectToDatabase();
    
    // Attempt Insertion. Unique compound index ensures no double-booking race conditions.
    await db.collection('appointments').insertOne(newAppointment);
    
    res.json({ success: true, bookingReference });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'This time slot was just booked. Please choose another.' });
    }
    res.status(500).json({ error: 'An error occurred while booking.' });
  }
});

// --- PUBLIC FRONTEND (HTML + CSS + JS) ---
const publicHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dentora Dental Care | Your Smile, Our Passion</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    :root {
      --bg: #F4F7FF; --primary: #6478F7; --primary-hover: #5061D8;
      --mint: #B9F3DF; --coral: #FF9D91; --lavender: #DCD5FF; --yellow: #FFE7A3;
      --text: #26324A; --text-light: #5A6A85; --white: #FFFFFF;
      --clay-shadow: 12px 12px 24px rgba(100, 120, 247, 0.08), -12px -12px 24px rgba(255, 255, 255, 0.9), inset 2px 2px 8px rgba(255, 255, 255, 0.5), inset -2px -2px 8px rgba(100, 120, 247, 0.03);
      --clay-inset: inset 6px 6px 12px rgba(100, 120, 247, 0.1), inset -6px -6px 12px rgba(255, 255, 255, 0.9);
      --clay-btn: 6px 6px 16px rgba(100, 120, 247, 0.3), -6px -6px 16px rgba(255, 255, 255, 0.9), inset 2px 2px 4px rgba(255, 255, 255, 0.4);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: var(--bg); color: var(--text); overflow-x: hidden; line-height: 1.6; }
    a { text-decoration: none; color: inherit; }
    section { padding: 80px 5%; max-width: 1300px; margin: 0 auto; position: relative; }
    
    /* Claymorphism Base */
    .clay-card { background: var(--white); border-radius: 28px; box-shadow: var(--clay-shadow); padding: 32px; transition: transform 0.3s ease; }
    .clay-card:hover { transform: translateY(-5px); }
    .clay-btn { background: var(--primary); color: var(--white); border: none; padding: 14px 28px; border-radius: 20px; font-weight: 600; cursor: pointer; box-shadow: var(--clay-btn); transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 8px; font-size: 16px; }
    .clay-btn:hover { background: var(--primary-hover); transform: translateY(-2px); }
    .clay-btn:active { box-shadow: inset 4px 4px 10px rgba(0,0,0,0.1); transform: translateY(0); }
    .clay-input { width: 100%; padding: 16px 20px; border-radius: 16px; border: none; background: var(--bg); box-shadow: var(--clay-inset); color: var(--text); font-size: 16px; outline: none; margin-top: 8px; }
    .clay-input:focus { box-shadow: inset 8px 8px 16px rgba(100, 120, 247, 0.15), inset -8px -8px 16px rgba(255, 255, 255, 0.9); }
    
    /* Navigation */
    nav { position: fixed; top: 20px; left: 5%; right: 5%; max-width: 1200px; margin: 0 auto; background: rgba(255, 255, 255, 0.8); backdrop-filter: blur(12px); border-radius: 24px; box-shadow: var(--clay-shadow); display: flex; justify-content: space-between; align-items: center; padding: 15px 30px; z-index: 1000; }
    .logo { font-size: 24px; font-weight: 700; color: var(--primary); display: flex; align-items: center; gap: 10px; }
    .nav-links { display: flex; gap: 30px; align-items: center; }
    .nav-links a { font-weight: 500; transition: color 0.3s; }
    .nav-links a:hover { color: var(--primary); }
    .mobile-menu-btn { display: none; background: none; border: none; cursor: pointer; color: var(--text); }
    
    /* Hero */
    .hero { display: flex; align-items: center; gap: 50px; min-height: 100vh; padding-top: 120px; }
    .hero-text { flex: 1; }
    .hero-text h1 { font-size: 56px; line-height: 1.1; margin-bottom: 20px; color: var(--text); }
    .hero-text p { font-size: 18px; color: var(--text-light); margin-bottom: 30px; }
    .hero-img-container { flex: 1; position: relative; }
    .hero-img { width: 100%; border-radius: 40px; box-shadow: var(--clay-shadow); object-fit: cover; height: 500px; }
    .floating-badge { position: absolute; background: var(--white); padding: 15px 20px; border-radius: 20px; box-shadow: var(--clay-shadow); display: flex; align-items: center; gap: 15px; font-weight: 600; animation: float 4s ease-in-out infinite; }
    .badge-1 { top: 40px; left: -30px; animation-delay: 0s; }
    .badge-2 { bottom: 40px; right: -20px; animation-delay: 2s; }
    
    @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-15px); } }

    /* Benefits */
    .benefits { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 30px; text-align: center; }
    .benefit-icon { width: 64px; height: 64px; border-radius: 20px; display: inline-flex; justify-content: center; align-items: center; margin-bottom: 15px; }
    .bg-mint { background: var(--mint); color: #0f5b40; } .bg-coral { background: var(--coral); color: #7a281e; } .bg-lavender { background: var(--lavender); color: #3b2b85; } .bg-yellow { background: var(--yellow); color: #7a6111; }

    /* Services */
    .section-title { text-align: center; font-size: 36px; margin-bottom: 50px; }
    .services-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 30px; }
    .service-card h3 { margin: 15px 0 10px; }
    .service-card p { color: var(--text-light); font-size: 14px; margin-bottom: 20px; }
    .service-price { font-weight: 700; color: var(--primary); font-size: 20px; margin-bottom: 20px; display: block; }
    .service-btn { background: var(--bg); color: var(--text); box-shadow: 4px 4px 10px rgba(100,120,247,0.1), -4px -4px 10px rgba(255,255,255,0.9); }
    .service-btn:hover { background: var(--white); }

    /* Doctor / About */
    .about-section { display: flex; gap: 50px; align-items: center; margin-top: 50px; }
    .doc-img { border-radius: 32px; width: 100%; max-width: 400px; box-shadow: var(--clay-shadow); }

    /* Booking Form */
    .booking-container { max-width: 800px; margin: 0 auto; background: var(--white); padding: 50px; border-radius: 32px; box-shadow: var(--clay-shadow); }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .form-group.full { grid-column: 1 / -1; }
    .form-group label { font-weight: 600; font-size: 14px; margin-left: 5px; }
    .time-slots { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
    .time-slot { padding: 10px 15px; border-radius: 12px; cursor: pointer; background: var(--bg); box-shadow: 2px 2px 6px rgba(0,0,0,0.05); text-align: center; border: 2px solid transparent; transition: 0.2s; font-size: 14px; }
    .time-slot:hover { transform: scale(1.05); }
    .time-slot.selected { background: var(--primary); color: var(--white); border-color: var(--primary); box-shadow: var(--clay-btn); }
    .time-slot.disabled { opacity: 0.4; cursor: not-allowed; text-decoration: line-through; }
    .checkbox-group { display: flex; gap: 10px; align-items: flex-start; margin-top: 20px; }
    .demo-notice { font-size: 12px; color: var(--text-light); text-align: center; margin-top: 20px; }

    /* Footer */
    footer { background: var(--white); border-radius: 40px 40px 0 0; padding: 60px 5% 30px; box-shadow: 0 -10px 30px rgba(100,120,247,0.05); margin-top: 50px; }
    .footer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 40px; max-width: 1200px; margin: 0 auto; }
    .footer-col h4 { margin-bottom: 20px; }
    .footer-col ul { list-style: none; }
    .footer-col ul li { margin-bottom: 10px; color: var(--text-light); }
    .footer-bottom { text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; margin-top: 40px; color: var(--text-light); font-size: 14px; }

    /* Success / Toast */
    #toast { position: fixed; bottom: 30px; right: 30px; background: var(--white); padding: 20px; border-radius: 16px; box-shadow: var(--clay-shadow); z-index: 2000; transform: translateY(100px); opacity: 0; transition: all 0.3s; display: flex; align-items: center; gap: 15px; }
    #toast.show { transform: translateY(0); opacity: 1; }

    @media (max-width: 768px) {
      .nav-links { display: none; flex-direction: column; position: absolute; top: 100%; left: 0; right: 0; background: var(--white); padding: 20px; border-radius: 20px; box-shadow: var(--clay-shadow); }
      .nav-links.active { display: flex; }
      .mobile-menu-btn { display: block; }
      .hero { flex-direction: column; text-align: center; padding-top: 100px; }
      .hero-text h1 { font-size: 40px; }
      .about-section { flex-direction: column; }
      .form-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <nav>
    <a href="#" class="logo"><i data-lucide="smile"></i> Dentora</a>
    <button class="mobile-menu-btn" onclick="document.querySelector('.nav-links').classList.toggle('active')"><i data-lucide="menu"></i></button>
    <div class="nav-links">
      <a href="#services">Services</a>
      <a href="#about">Our Dentist</a>
      <a href="#booking" class="clay-btn" style="padding: 10px 20px;">Book Now</a>
    </div>
  </nav>

  <section class="hero">
    <div class="hero-text">
      <h1>A Healthier Smile Starts Here.</h1>
      <p>Experience gentle, modern, and patient-focused dental care in a relaxing environment. We bring art and science together for your perfect smile.</p>
      <div style="display: flex; gap: 20px; justify-content: flex-start; flex-wrap: wrap; margin-top: 20px;">
        <a href="#booking" class="clay-btn">Book Appointment <i data-lucide="arrow-right"></i></a>
        <a href="#services" class="clay-btn service-btn">Explore Services</a>
      </div>
    </div>
    <div class="hero-img-container">
      <img src="https://images.unsplash.com/photo-1606811841689-23dfddce3e95?auto=format&fit=crop&w=800&q=80" alt="Modern Dental Clinic" class="hero-img">
      <div class="floating-badge badge-1"><i data-lucide="star" style="color: #F59E0B"></i> 4.9/5 Sample Rating</div>
      <div class="floating-badge badge-2"><i data-lucide="shield-check" style="color: var(--primary)"></i> Modern Tech</div>
    </div>
  </section>

  <section class="benefits">
    <div class="clay-card"><div class="benefit-icon bg-mint"><i data-lucide="heart"></i></div><h3>Patient First</h3><p>Gentle care tailored to you.</p></div>
    <div class="clay-card"><div class="benefit-icon bg-coral"><i data-lucide="zap"></i></div><h3>Modern Tech</h3><p>Advanced, painless procedures.</p></div>
    <div class="clay-card"><div class="benefit-icon bg-lavender"><i data-lucide="calendar-check"></i></div><h3>Easy Booking</h3><p>Convenient online scheduling.</p></div>
    <div class="clay-card"><div class="benefit-icon bg-yellow"><i data-lucide="smile"></i></div><h3>Friendly Staff</h3><p>A welcoming environment.</p></div>
  </section>

  <section id="services">
    <h2 class="section-title">Our Services</h2>
    <div class="services-grid" id="services-container">
      <!-- Services loaded via JS -->
    </div>
  </section>

  <section id="about" class="about-section">
    <img src="https://images.unsplash.com/photo-1594824436998-df40182ce7c6?auto=format&fit=crop&w=500&q=80" alt="Dr. Aanya Sharma" class="doc-img">
    <div>
      <h2 class="section-title" style="text-align: left;">Meet Dr. Aanya Sharma</h2>
      <p style="color: var(--primary); font-weight: 600; margin-bottom: 20px;">BDS, MDS (Sample Credentials)</p>
      <p class="clay-card" style="margin-bottom: 30px;">"At Dentora, we believe every smile tells a story. Our fictional clinic demonstrates the highest standard of UI design while showing how seamlessly patient management can operate. (This is a sample biography for demonstration)."</p>
      <ul style="list-style: none; line-height: 2; color: var(--text-light);">
        <li><i data-lucide="check-circle" style="color: var(--mint); vertical-align: middle;"></i> Specialist in Cosmetic Dentistry</li>
        <li><i data-lucide="check-circle" style="color: var(--mint); vertical-align: middle;"></i> 10+ Years Fictional Experience</li>
      </ul>
    </div>
  </section>

  <section id="booking">
    <div class="booking-container">
      <h2 class="section-title" style="margin-bottom: 10px;">Book Your Consultation</h2>
      <p class="demo-notice" style="margin-top: 0; margin-bottom: 30px;">Secure your fictional slot in our database.</p>
      
      <form id="booking-form">
        <div class="form-grid">
          <div class="form-group">
            <label>Full Name</label>
            <input type="text" id="b-name" class="clay-input" required placeholder="John Doe">
          </div>
          <div class="form-group">
            <label>Phone Number</label>
            <input type="tel" id="b-phone" class="clay-input" required placeholder="+91 9876543210" pattern="[0-9+\\s-]{10,}">
          </div>
          <div class="form-group">
            <label>Email Address</label>
            <input type="email" id="b-email" class="clay-input" required placeholder="john@example.com">
          </div>
          <div class="form-group">
            <label>Service</label>
            <select id="b-service" class="clay-input" required>
              <option value="" disabled selected>Select a Service</option>
            </select>
          </div>
          <div class="form-group">
            <label>Preferred Date</label>
            <input type="date" id="b-date" class="clay-input" required>
          </div>
          <div class="form-group">
            <label>Available Slots</label>
            <div id="b-slots" class="time-slots">
              <span style="font-size: 14px; color: var(--text-light); margin-top: 10px;">Select a date first.</span>
            </div>
            <input type="hidden" id="b-timeslot" required>
          </div>
          <div class="form-group full">
            <label>Message (Optional)</label>
            <textarea id="b-message" class="clay-input" rows="3" placeholder="Any specific concerns?"></textarea>
          </div>
          <div class="form-group full checkbox-group">
            <input type="checkbox" id="b-consent" required style="margin-top: 5px;">
            <label for="b-consent" style="font-weight: 400; font-size: 13px;">I consent to this demonstration clinic storing my submitted details for appointment purposes.</label>
          </div>
          <div class="form-group full">
            <button type="submit" class="clay-btn" style="width: 100%; justify-content: center;" id="submit-btn">Confirm Booking</button>
          </div>
        </div>
      </form>
      <div id="success-screen" style="display: none; text-align: center; padding: 40px 0;">
        <i data-lucide="check-circle" style="color: var(--mint); width: 80px; height: 80px; margin-bottom: 20px;"></i>
        <h2>Booking Received!</h2>
        <p>Your request is pending clinic approval.</p>
        <div class="clay-card" style="display: inline-block; margin-top: 20px; padding: 15px 30px;">
          <span style="font-size: 12px; color: var(--text-light); text-transform: uppercase;">Booking Ref</span><br>
          <strong style="font-size: 20px; color: var(--primary);" id="ref-display"></strong>
        </div>
        <br><br>
        <button class="clay-btn service-btn" onclick="location.reload()">Book Another</button>
      </div>
    </div>
  </section>

  <footer>
    <div class="footer-grid">
      <div class="footer-col">
        <h3 class="logo"><i data-lucide="smile"></i> Dentora</h3>
        <p style="color: var(--text-light); margin-top: 15px; font-size: 14px;">Your Smile, Our Passion.<br>A demonstration project.</p>
      </div>
      <div class="footer-col">
        <h4>Contact (Dummy)</h4>
        <ul>
          <li><i data-lucide="map-pin" style="width:16px; vertical-align: middle;"></i> 2nd Floor, Smile Plaza, Noida</li>
          <li><i data-lucide="phone" style="width:16px; vertical-align: middle;"></i> +91 98765 43210</li>
          <li><i data-lucide="mail" style="width:16px; vertical-align: middle;"></i> hello@dentora.example</li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Hours</h4>
        <ul>
          <li>Mon - Sat: 9:00 AM - 7:00 PM</li>
          <li>Sunday: Closed</li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      &copy; 2026 Dentora Dental Care (Fictional Demo). All rights reserved. <a href="/admin" style="text-decoration: underline;">Admin Panel</a>
    </div>
  </footer>

  <div id="toast"><i data-lucide="info"></i> <span id="toast-msg"></span></div>

  <script>
    lucide.createIcons();
    
    const showToast = (msg, isError = false) => {
      const toast = document.getElementById('toast');
      document.getElementById('toast-msg').innerText = msg;
      toast.style.borderLeft = isError ? '4px solid var(--coral)' : '4px solid var(--mint)';
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 4000);
    };

    // Load Services
    fetch('/api/services').then(r => r.json()).then(services => {
      const container = document.getElementById('services-container');
      const select = document.getElementById('b-service');
      services.forEach(s => {
        // Build cards
        container.innerHTML += '<div class="clay-card service-card">' +
          '<h3>' + s.name + '</h3>' +
          '<span class="service-price">Starts at ' + s.price + '</span>' +
          '<p>Sample description for professional ' + s.name.toLowerCase() + ' care.</p>' +
          '<button class="clay-btn service-btn" onclick="selectService(\\'' + s.id + '\\')">Book Now</button>' +
          '</div>';
        // Build select options
        select.innerHTML += '<option value="' + s.id + '">' + s.name + '</option>';
      });
    });

    window.selectService = (id) => {
      document.getElementById('b-service').value = id;
      document.getElementById('booking').scrollIntoView({ behavior: 'smooth' });
    };

    // Date Rules
    const dateInput = document.getElementById('b-date');
    const today = new Date();
    today.setDate(today.getDate() + 1); // min tomorrow
    dateInput.min = today.toISOString().split('T')[0];

    dateInput.addEventListener('change', async (e) => {
      const date = e.target.value;
      const d = new Date(date);
      const slotsContainer = document.getElementById('b-slots');
      document.getElementById('b-timeslot').value = '';
      
      if (d.getDay() === 0) {
        slotsContainer.innerHTML = '<span style="color:var(--coral)">Clinic closed on Sundays.</span>';
        return;
      }
      
      slotsContainer.innerHTML = '<span>Loading...</span>';
      try {
        const res = await fetch('/api/availability?date=' + date);
        const data = await res.json();
        
        if (data.availableSlots.length === 0) {
          slotsContainer.innerHTML = '<span style="color:var(--coral)">No slots available.</span>';
          return;
        }
        
        slotsContainer.innerHTML = '';
        data.availableSlots.forEach(slot => {
          const span = document.createElement('span');
          span.className = 'time-slot';
          span.innerText = slot;
          span.onclick = () => {
            document.querySelectorAll('.time-slot').forEach(el => el.classList.remove('selected'));
            span.classList.add('selected');
            document.getElementById('b-timeslot').value = slot;
          };
          slotsContainer.appendChild(span);
        });
      } catch (err) {
        slotsContainer.innerHTML = '<span>Error loading slots.</span>';
      }
    });

    // Form Submission
    document.getElementById('booking-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const timeSlot = document.getElementById('b-timeslot').value;
      if (!timeSlot) return showToast('Please select a time slot.', true);
      
      const btn = document.getElementById('submit-btn');
      const originalText = btn.innerHTML;
      btn.innerHTML = 'Submitting...';
      btn.disabled = true;
      
      const payload = {
        patientName: document.getElementById('b-name').value,
        phone: document.getElementById('b-phone').value,
        email: document.getElementById('b-email').value,
        service: document.getElementById('b-service').value,
        appointmentDate: document.getElementById('b-date').value,
        timeSlot: timeSlot,
        message: document.getElementById('b-message').value
      };
      
      try {
        const res = await fetch('/api/appointments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (res.ok) {
          document.getElementById('booking-form').style.display = 'none';
          document.getElementById('success-screen').style.display = 'block';
          document.getElementById('ref-display').innerText = data.bookingReference;
          showToast('Booking Request Received!');
        } else {
          showToast(data.error || 'Booking failed.', true);
          if (res.status === 409) {
             // trigger reload of slots
             dateInput.dispatchEvent(new Event('change'));
          }
        }
      } catch (err) {
        showToast('Network error. Please try again.', true);
      } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.send(publicHTML);
});

// 404 Fallback
app.use((req, res) => {
  if (req.path.startsWith('/api/')) res.status(404).json({ error: 'Endpoint not found.' });
  else res.redirect('/');
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Dentora Server running on port ${PORT}`));
}
