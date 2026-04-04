const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');

/**
 * CONFIGURATION
 */
const TEMP_DIR = path.join(__dirname, 'temp_videos');

// Ensure temp directory exists
fs.ensureDirSync(TEMP_DIR);

/**
 * AUTHORIZED NUMBERS
 * Add the phone numbers (with country code, e.g. '96590967095@c.us') 
 * that are allowed to trigger the bot here.
 */
const AUTHORIZED_NUMBERS = [
    '96590967095@c.us', // Your number
    '96566154015@c.us', // Your mom's number
    '195524426752006@lid', // Your sender ID
    // Add other authorized numbers here
];

// Detect Termux environment and Chromium path
const isTermux = (process.env.PREFIX === '/data/data/com.termux/files/usr') || (process.arch === 'arm64' && process.platform === 'linux');

function findChromiumPath() {
    if (!isTermux) return undefined;

    const possiblePaths = [
        '/data/data/com.termux/files/usr/bin/chromium',
        '/data/data/com.termux/files/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ];

    for (const p of possiblePaths) {
        if (require('fs').existsSync(p)) return p;
    }

    return undefined; // Let Puppeteer use its bundled version
}

const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || findChromiumPath();

console.log(`[DEBUG] Environment: Termux=${isTermux}, Arch=${process.arch}, OS=${process.platform}`);
if (isTermux) console.log(`[DEBUG] Using Chromium at: ${chromiumPath}`);

const MONGODB_URI = process.env.MONGODB_URI;
let client;
let qrCodeData = null;
let botReady = false;

async function initializeBot() {
    let authStrategyConfig;

    if (MONGODB_URI) {
        console.log('[DEBUG] MONGODB_URI found! Connecting to MongoDB for RemoteAuth...');
        await mongoose.connect(MONGODB_URI);
        console.log('[DEBUG] Connected to MongoDB successfully. Setting up RemoteAuth.');
        
        const store = new MongoStore({ mongoose: mongoose });
        authStrategyConfig = new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000
        });
    } else {
        console.log('[DEBUG] No MONGODB_URI provided. Falling back to LocalAuth (Ephemeral, loses session on restart).');
        authStrategyConfig = new LocalAuth();
    }

    client = new Client({
        authStrategy: authStrategyConfig,
        authTimeoutMs: 60000, // Increase timeout for slower connections
        puppeteer: {
            headless: true,
            executablePath: chromiumPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--single-process', // Critical for ARM64/Android stability
                '--no-zygote',
                '--no-first-run'
            ]
        }
    });

    /**
     * QR Code Generation
     */
    client.on('qr', (qr) => {
        qrCodeData = qr;
        botReady = false; // If we get a QR, we are definitely not ready
        console.log('\n--- SCAN THE QR CODE BELOW ---');
        console.log('Go to your Render Web Service URL in your browser to scan the QR code visually!');
        qrcode.generate(qr, { small: true });
    });

    client.on('remote_session_saved', () => {
        console.log('[DEBUG] Session successfully backed up to MongoDB.');
    });

    client.on('ready', () => {
        qrCodeData = null; // Clear it once connected
        botReady = true;
        console.log('\nWhatsApp Bot is ready and listening!');
        console.log('Mode: Restricted Access (Authorized numbers only)');
        console.log(`Authorized Numbers: ${AUTHORIZED_NUMBERS.join(', ')}`);
    });

    /**
     * Message Listener
     */
    client.on('message_create', async (msg) => {
        const text = msg.body.trim().toLowerCase();

        // Identity check
        const sender = msg.author || msg.from;

        // Log all incoming messages for debugging
        console.log(`[DEBUG] Incoming message from ${sender} (fromMe: ${msg.fromMe}): ${msg.body.substring(0, 50)}...`);

        // RESTRICTION: Only respond to authorized numbers OR messages sent by the linked phone itself
        if (!msg.fromMe && !AUTHORIZED_NUMBERS.includes(sender)) {
            console.log(`[DEBUG] Unauthorized access attempt from ${sender}. Ignoring.`);
            return;
        }

        const hasFbLink = /(facebook\.com|fb\.watch|fb\.com|fb\.me)/i.test(msg.body);

        if (hasFbLink) {
            console.log(`\n[${new Date().toLocaleTimeString()}] Processing link from: ${msg.from}`);

            // More flexible URL matching
            const urlMatch = msg.body.match(/(https?:\/\/[^\s]+|www\.facebook\.com[^\s]+|fb\.watch[^\s]+|fb\.com[^\s]+)/i);

            if (!urlMatch) {
                return;
            }

            let url = urlMatch[0];
            if (!url.startsWith('http')) {
                url = 'https://' + url;
            }

            console.log(`[DEBUG] Extracted URL: ${url}`);
            const filename = `fb_video_${Date.now()}.mp4`;
            const filePath = path.join(TEMP_DIR, filename);

            try {
                await msg.reply('⏳ Hang on! I\'m fetching that video for you...');

                const downloadPromise = downloadFacebookVideo(url, filePath);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Download timed out after 2 minutes')), 120000)
                );

                await Promise.race([downloadPromise, timeoutPromise]);

                if (await fs.pathExists(filePath)) {
                    console.log('Sending video...');
                    const media = MessageMedia.fromFilePath(filePath);

                    await client.sendMessage(msg.from, media, {
                        caption: 'Here is your Facebook video! 🎬',
                        quotedMessageId: msg.id._serialized
                    });

                    console.log('✓ Success: Video sent.');
                } else {
                    throw new Error('Download failed: File not found.');
                }

            } catch (error) {
                console.error('✘ Error:', error.message);
                await msg.reply('❌ Oops! I couldn\'t download that video. It might be private or the link might be broken.');
            } finally {
                if (await fs.pathExists(filePath)) {
                    await fs.remove(filePath);
                }
            }
        }
    });

    console.log('Starting WhatsApp Client...');
    client.initialize().catch(err => {
        console.error('Initialization Error:', err);
    });
}

const puppeteer = require('puppeteer');

/**
 * Custom Facebook Video Downloader
 * Scrapes the page using Puppeteer to handle redirects and obfuscation
 */
async function downloadFacebookVideo(url, outputPath) {
    console.log(`[DEBUG] Step 1: Launching browser to fetch: ${url}`);

    let page;
    try {
        if (!client.pupBrowser) {
            throw new Error("Browser instance is not ready yet.");
        }
        page = await client.pupBrowser.newPage();

        // Use a realistic, modern user agent
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Upgrade-Insecure-Requests': '1'
        });

        // 🚀 SPEED OPTIMIZATION: Block heavy layout assets
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const blockedTypes = ['image', 'stylesheet', 'font', 'media', 'other'];
            // We only need the HTML document and maybe scripts to load the underlying URL
            if (blockedTypes.includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log(`[DEBUG] Step 2: Navigating to page...`);
        // Use a longer timeout and wait for network to be idle
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

        // Sometimes FB redirects to a login page or a different URL
        const finalUrl = page.url();
        console.log(`[DEBUG] Step 3: Final URL: ${finalUrl}`);

        const html = await page.content();

        // Check for common blocking indicators
        if (html.includes('id="login_form"') || html.includes('login_button_inline') || finalUrl.includes('facebook.com/login')) {
            console.log(`[DEBUG] Blocked by login wall.`);
            throw new Error('Facebook is asking for login. This video might be private or protected.');
        }

        // Try to find video URL in common patterns
        let videoUrl = '';

        // 1. Check for Meta Tags (highest reliability)
        videoUrl = await page.evaluate(() => {
            const selectors = [
                'meta[property="og:video"]',
                'meta[property="og:video:secure_url"]',
                'meta[property="og:video:url"]',
                'meta[name="twitter:player:stream"]'
            ];
            for (const s of selectors) {
                const el = document.querySelector(s);
                if (el && el.content && el.content.startsWith('http')) return el.content;
            }
            return null;
        });

        // 2. Comprehensive Regex Patterns in HTML source
        if (!videoUrl) {
            const patterns = [
                /"playable_url_quality_sd":"([^"]+)"/,
                /sd_src:"([^"]+)"/,
                /sd_src_no_ratelimit:"([^"]+)"/,
                /browser_native_sd_url":"([^"]+)"/,
                /"playable_url_quality_hd":"([^"]+)"/,
                /hd_src:"([^"]+)"/,
                /hd_src_no_ratelimit:"([^"]+)"/,
                /browser_native_hd_url":"([^"]+)"/,
                /"playable_url":"([^"]+)"/,
                /video_url:"([^"]+)"/,
                /video_url\\":\\"([^\\"]+)\\"/
            ];

            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match && match[1]) {
                    // Clean up the URL (unescape characters)
                    videoUrl = match[1].replace(/\\/g, '');
                    // FB URLs sometimes come with encoded ampersands
                    videoUrl = videoUrl.replace(/&amp;/g, '&');

                    if (videoUrl.startsWith('http')) {
                        console.log(`[DEBUG] Found video URL with pattern: ${pattern.toString().substring(0, 40)}...`);
                        break;
                    } else {
                        videoUrl = ''; // Reset if it's not a real URL
                    }
                }
            }
        }

        if (!videoUrl) {
            console.log(`[DEBUG] Scraper failed to find source. HTML snippet (1000 chars):`);
            console.log(html.substring(0, 1000).replace(/\s+/g, ' '));
            throw new Error('Could not find video source URL. The link might be expired or restricted.');
        }

        console.log(`[DEBUG] Step 4: Starting download...`);

        // Close page before downloading to save resources
        await page.close();
        page = null;

        // Use axios for the actual binary download
        const videoResponse = await axios({
            method: 'get',
            url: videoUrl,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(outputPath);
        videoResponse.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

    } catch (error) {
        console.error('[DEBUG] Scraper error:', error.message);
        if (page) await page.close();
        throw error;
    }
}

// --- RENDER WEB SERVICE HEALTH CHECK & QR CODE VISUALIZER ---
// Render requires web services to bind to a port, otherwise the deploy fails.
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    if (req.url === '/') {
        if (qrCodeData) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot - QR Code</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
                <style>
                    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f0f2f5; margin: 0; }
                    .card { background: white; padding: 2rem; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 600px; }
                    #qrcode { margin-top: 1.5rem; display: flex; justify-content: center; background: white; padding: 10px; border-radius: 10px; }
                    h2 { margin-top: 0; color: #128C7E; }
                    p { color: #555; line-height: 1.5; }
                    .warning { background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 5px; font-weight: bold; margin-bottom: 15px;}
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>WhatsApp Authentication</h2>
                    <div class="warning">
                        ⚠️ DO NOT use your normal phone camera to scan this! It will say "URL cannot be scanned".
                    </div>
                    <p><strong>Step 1:</strong> Open WhatsApp on your phone.<br>
                       <strong>Step 2:</strong> Go to Settings > <b>Linked Devices</b>.<br>
                       <strong>Step 3:</strong> Tap "Link a Device" and scan the code below.</p>
                    <div id="qrcode"></div>
                    <p style="font-size: 12px; margin-top: 15px;">Page auto-refreshes every 10 seconds.</p>
                </div>
                <script>
                    new QRCode(document.getElementById("qrcode"), {
                        text: "${qrCodeData}",
                        width: 400,
                        height: 400,
                        colorDark : "#000000",
                        colorLight : "#ffffff",
                        correctLevel : QRCode.CorrectLevel.M
                    });
                    
                    // Auto-refresh the page every 10 seconds to check if authenticated or new QR
                    setTimeout(() => location.reload(), 10000);
                </script>
            </body>
            </html>
            `);
            res.end();
        } else if (botReady) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot Status</title>
                <style>
                    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f0f2f5; margin: 0; }
                    .card { background: white; padding: 2rem; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
                    h2 { color: #128C7E; margin-top: 0; }
                    p { color: #555; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>✅ WhatsApp Bot is Running!</h2>
                    <p>The bot is correctly linked to your WhatsApp account and actively listening for messages.</p>
                </div>
            </body>
            </html>
            `);
            res.end();
        } else {
            // Neither ready nor showing QR code means it's starting up
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot - Starting...</title>
                <style>
                    body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f0f2f5; margin: 0; }
                    .card { background: white; padding: 2rem; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
                    h2 { color: #f59e0b; margin-top: 0; }
                    p { color: #555; }
                    .loader { border: 4px solid #f3f3f3; border-top: 4px solid #f59e0b; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 0 auto 15px auto; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="loader"></div>
                    <h2>⏳ Bot is Initializing...</h2>
                    <p>The Chrome browser is starting up in the background.</p>
                    <p><strong>Please wait about 20-30 seconds.</strong> If you need to link your device, the QR code will appear shortly.</p>
                </div>
                <script>
                    // Auto-refresh the page every 5 seconds while waiting for init
                    setTimeout(() => location.reload(), 5000);
                </script>
            </body>
            </html>
            `);
            res.end();
        }
    } else {
        res.writeHead(404);
        res.end();
    }
}).listen(port, () => {
    console.log(`Health check server listening on port ${port} / QR Visualizer URL`);
});

// Boot everything up
initializeBot();

// GLOBAL ERROR HANDLING TO PREVENT CRASHES
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
