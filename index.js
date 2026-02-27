const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

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

    return 'chromium'; // Fallback
}

const chromiumPath = findChromiumPath();

console.log(`[DEBUG] Environment: Termux=${isTermux}, Arch=${process.arch}, OS=${process.platform}`);
if (isTermux) console.log(`[DEBUG] Using Chromium at: ${chromiumPath}`);

const client = new Client({
    authStrategy: new LocalAuth(),
    authTimeoutMs: 60000, // Increase timeout for slower mobile connections
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

const puppeteer = require('puppeteer');

/**
 * Custom Facebook Video Downloader
 * Scrapes the page using Puppeteer to handle redirects and obfuscation
 */
async function downloadFacebookVideo(url, outputPath) {
    console.log(`[DEBUG] Step 1: Launching browser to fetch: ${url}`);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: chromiumPath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote'
            ]
        });

        const page = await browser.newPage();

        // Use a realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36');

        console.log(`[DEBUG] Step 2: Navigating to page...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const finalUrl = page.url();
        console.log(`[DEBUG] Step 3: Final URL: ${finalUrl}`);

        const html = await page.content();

        // Try to find video URL in common patterns
        let videoUrl = '';

        // 1. Check for Reels specific video URL or og:video
        videoUrl = await page.evaluate(() => {
            const meta = document.querySelector('meta[property="og:video"]') ||
                document.querySelector('meta[property="og:video:secure_url"]') ||
                document.querySelector('meta[name="twitter:player:stream"]');
            return meta ? meta.content : null;
        });

        // 2. Generic Regex Patterns in HTML source
        if (!videoUrl) {
            const patterns = [
                /hd_src:"([^"]+)"/,
                /sd_src:"([^"]+)"/,
                /"playable_url":"([^"]+)"/,
                /"playable_url_quality_hd":"([^"]+)"/,
                /video_url:"([^"]+)"/,
                /video_url\\":\\"([^\\"]+)\\"/,
                /browser_native_sd_url":"([^"]+)"/,
                /browser_native_hd_url":"([^"]+)"/
            ];

            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match && match[1]) {
                    videoUrl = match[1].replace(/\\/g, '');
                    console.log(`[DEBUG] Found video URL with pattern: ${pattern.toString().substring(0, 30)}...`);
                    break;
                }
            }
        }

        if (!videoUrl) {
            if (html.includes('id="login_form"') || html.includes('login_button_inline')) {
                throw new Error('Facebook is asking for login. This video might be protected.');
            }
            throw new Error('Could not find video source URL. Try a different link.');
        }

        console.log(`[DEBUG] Step 4: Downloading file from source...`);

        // Close browser before downloading to save resources
        await browser.close();
        browser = null;

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
        if (browser) await browser.close();
        throw error;
    }
}

/**
 * QR Code Generation
 */
client.on('qr', (qr) => {
    console.log('\n--- SCAN THE QR CODE BELOW ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\nWhatsApp Bot is ready and listening!');
    console.log('Mode: Restricted Access (Authorized numbers only)');
    console.log(`Authorized Numbers: ${AUTHORIZED_NUMBERS.join(', ')}`);
});

/**
 * Message Listener
 * Using 'message_create' to catch messages sent by YOURSELF too.
 */
client.on('message_create', async (msg) => {
    const text = msg.body.trim().toLowerCase();

    // DEBUG: Log EVERY message to the terminal so we can see what's happening
    console.log(`\n[DEBUG] New Message: "${msg.body}"`);
    console.log(`[DEBUG] From: ${msg.from} | FromMe: ${msg.fromMe}`);

    // If it's from YOU, only proceed if it contains 'waiz'
    // This prevents the bot from hearing its own "Hang on!" messages
    if (msg.fromMe && !text.includes('waiz')) {
        return;
    }

    // RESTRICTION: Only respond to authorized numbers
    if (!AUTHORIZED_NUMBERS.includes(msg.from)) {
        // console.log(`[DEBUG] Ignored unauthorized message from: ${msg.from}`);
        return;
    }

    // Simple Ping Command for testing
    if (text === 'ping' || text === 'hi' || text === 'hello') {
        console.log('[DEBUG] Ping received, replying...');
        await msg.reply('👋 I am awake and listening!');
        return;
    }

    // Check for trigger keyword 'waiz' (case-insensitive)
    const hasTrigger = text.includes('waiz'); // Using .includes to be safer
    const hasFbLink = text.includes('facebook.com') || text.includes('fb.watch');

    console.log(`[DEBUG] hasTrigger: ${hasTrigger}, hasFbLink: ${hasFbLink}`);

    if (hasTrigger && hasFbLink) {
        console.log(`\n[${new Date().toLocaleTimeString()}] Processing link from: ${msg.from}`);

        const urlMatch = msg.body.match(/https?:\/\/[^\s]+/);
        if (!urlMatch) return;

        const url = urlMatch[0];
        const filename = `fb_video_${Date.now()}.mp4`;
        const filePath = path.join(TEMP_DIR, filename);

        try {
            await msg.reply('⏳ Hang on! I\'m fetching that video for you...');

            console.log('Downloading video...');
            await downloadFacebookVideo(url, filePath);

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
                console.log('Cleaned up temporary file.');
            }
        }
    }
});

console.log('Starting WhatsApp Client...');
client.initialize().catch(err => {
    console.error('Initialization Error:', err);
});
