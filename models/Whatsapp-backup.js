const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const os     = require('os');
const path   = require('path');

// ================= GLOBAL STATE =================
let client         = null;
let isInitialized  = false;
let isInitializing = false;
let restartTimer   = null;

// ================= SESSION PATH =================
const sessionPath = os.platform() === 'linux'
  ? '/var/lib/jenkins/whatsapp_session'
  : path.join(__dirname, 'whatsapp_session');

// ================= LOGGER =================
const log   = (...a) => console.log("🟢",  ...a);
const error = (...a) => console.error("🔴", ...a);

// ================= READY CHECK =================
// Guards against the window where client exists but Puppeteer page is already dead
function isReady() {
  try {
    return (
      isInitialized &&
      client        &&
      client.pupPage &&
      !client.pupPage.isClosed()
    );
  } catch {
    return false;
  }
}

// ================= MESSAGE QUEUE =================
const queue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  while (queue.length > 0) {
    const { number, text, resolve } = queue.shift();

    if (!isReady()) {
      resolve({ success: false, error: "not_ready" });
      continue;
    }

    try {
      // ✅ KEY FIX: getChatById forces WA to open chat first,
      //    allowing delivery to numbers with NO prior conversation.
      const chat = await client.getChatById(number);
      await chat.sendMessage(text);
      resolve({ success: true });
    } catch (err) {
      error("Send error:", err.message);
      resolve({ success: false, error: err.message });

      const isCrash =
        err.message.includes("timed out")             ||
        err.message.includes("context was destroyed") ||
        err.message.includes("Session closed")        ||
        err.message.includes("getChat")               ||
        err.message.includes("getChatById")           ||
        err.message.includes("WidFactory")            ||
        err.message.includes("Target closed");

      if (isCrash) {
        isInitialized = false; // immediately mark not ready
        scheduleRestart("Browser crash during send");
        break;
      }
    }

    // 200 ms between sends — fast enough, safe enough
    await new Promise(r => setTimeout(r, 200));
  }

  isProcessing = false;
}

function enqueue(number, text) {
  return new Promise((resolve) => {
    queue.push({ number, text, resolve });
    processQueue();
  });
}

// ================= DRAIN QUEUE =================
// Resolves all pending promises before a restart so callers don't hang
function drainQueue(reason) {
  while (queue.length > 0) {
    const { resolve } = queue.shift();
    resolve({ success: false, error: reason });
  }
  isProcessing = false;
}

// ================= FORMAT NUMBER =================
function formatNumber(phone) {
  const clean    = phone.toString().replace(/\D/g, "");
  const withCode = clean.startsWith("91") ? clean : `91${clean}`;
  return `${withCode}@c.us`;
}

// ================= CREATE CLIENT =================
function createClient() {
  log("⚙️ Creating WhatsApp client...");
  return new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    puppeteer: {
      headless: true,
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ]
    }
  });
}

// ================= INIT =================
async function startWhatsApp() {
  if (isInitializing) {
    log("⏳ Already initializing, skipping...");
    return;
  }

  isInitializing = true;
  isInitialized  = false;

  try {
    if (client) {
      try { await client.destroy(); } catch {}
      client = null;
    }

    client = createClient();

    client.on('qr', (qr) => {
      log("📲 Scan QR to connect WhatsApp:");
      qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
      isInitialized  = true;
      isInitializing = false;
      log("✅ WhatsApp Connected and Ready!");
      processQueue(); // flush anything queued during startup
    });

    client.on('auth_failure', (msg) => {
      isInitialized  = false;
      isInitializing = false;
      error("❌ Auth failure:", msg);
      scheduleRestart("Auth failure");
    });

    client.on('disconnected', (reason) => {
      isInitialized  = false;
      isInitializing = false;
      error("⚠️ Disconnected:", reason);
      scheduleRestart(reason);
    });

    client.on('loading_screen', (percent, msg) => {
      log(`⏳ Loading ${percent}% — ${msg}`);
    });

    log("🚀 Initializing WhatsApp...");
    await client.initialize();

  } catch (err) {
    isInitialized  = false;
    isInitializing = false;
    error("💥 Init crash:", err.message);
    scheduleRestart(err.message);
  }
}

// ================= RESTART =================
function scheduleRestart(reason) {
  if (restartTimer) clearTimeout(restartTimer);
  drainQueue(reason); // resolve all pending promises immediately
  error("🔄 Scheduling restart due to:", reason);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startWhatsApp();
  }, 8000);
}

// ================= START =================
setTimeout(() => startWhatsApp(), 3000);

// ================= REGISTRATION CHECK =================
// Shared helper — 10s timeout, fails open (assumes registered)
async function checkRegistered(number) {
  try {
    return await Promise.race([
      client.isRegisteredUser(number),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("isRegisteredUser timeout")), 10000)
      )
    ]);
  } catch (e) {
    error("isRegisteredUser failed:", e.message);
    return true; // fail open — let sendMessage be the final arbiter
  }
}

// ================= SEND OTP =================
const sendWhatsAppOTP = async (phone, otp) => {
  try {
    if (!isReady()) {
      error("⏳ WhatsApp not ready for OTP");
      return { success: false, error: "not_ready" };
    }

    const number = formatNumber(phone);
    const isRegistered = await checkRegistered(number);

    if (!isRegistered) {
      error("❌ Not on WhatsApp:", phone);
      return { success: false, error: "not_whatsapp" };
    }

    const text =
`🔐 *HostelNode OTP*

Your OTP is: *${otp}*

Valid for 5 minutes.

https://hostelnode.com`;

    const result = await enqueue(number, text);
    if (result.success) log("✅ OTP sent:", phone);
    return result;

  } catch (err) {
    error("❌ OTP send error:", err.message);
    return { success: false, error: err.message };
  }
};

// ================= SEND GENERIC MESSAGE =================
const sendWhatsAppMessage = async (phone, text) => {
  try {
    if (!isReady()) {
      error("⏳ WhatsApp not ready");
      return false;
    }

    const number = formatNumber(phone);
    const isRegistered = await checkRegistered(number);

    if (!isRegistered) {
      error("❌ Number not on WhatsApp:", phone);
      return false;
    }

    const result = await enqueue(number, text);
    if (result.success) log("✅ Generic WA sent:", phone);
    return result.success;

  } catch (err) {
    error("❌ Generic WA send error:", err.message);
    return false;
  }
};

// ================= SEND OWNER ENQUIRY =================
const sendOwnerEnquiryMessage = async (phone, data) => {
  try {
    if (!isReady()) {
      error("⏳ WhatsApp not ready");
      return;
    }

    const number = formatNumber(phone);

    const text =
`🏠 *New Enquiry — HostelNode*

👤 ${data.studentName}
📞 ${data.studentPhone}

🏢 ${data.hostelName}
🛏 ${data.roomType || "N/A"}
📅 ${data.moveIn   || "N/A"}

💬 ${data.message  || "No message"}

👉 Chat: https://wa.me/${data.studentPhone}`;

    const result = await enqueue(number, text);
    if (result.success) log("✅ Enquiry sent to owner:", phone);

  } catch (err) {
    error("❌ Enquiry send error:", err.message);
  }
};

// ================= EXPORT =================
module.exports = {
  sendWhatsAppOTP,
  sendOwnerEnquiryMessage,
  sendWhatsAppMessage
};