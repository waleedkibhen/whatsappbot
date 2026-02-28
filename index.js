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

        // Use a realistic, modern user agent
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Upgrade-Insecure-Requests': '1'
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
                /"playable_url":"([^"]+)"/,
                /"playable_url_quality_hd":"([^"]+)"/,
                /"playable_url_quality_sd":"([^"]+)"/,
                /hd_src:"([^"]+)"/,
                /sd_src:"([^"]+)"/,
                /sd_src_no_ratelimit:"([^"]+)"/,
                /hd_src_no_ratelimit:"([^"]+)"/,
                /video_url:"([^"]+)"/,
                /video_url\\":\\"([^\\"]+)\\"/,
                /browser_native_sd_url":"([^"]+)"/,
                /browser_native_hd_url":"([^"]+)"/
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

        console.log(`[DEBUG] Step 4: Downloading file from source...`);

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

    // Identity check
    const sender = msg.author || msg.from;

    // Log all incoming messages for debugging (can be noisy, but helpful for now)
    console.log(`[DEBUG] Incoming message from ${sender}: ${msg.body.substring(0, 50)}...`);

    // RESTRICTION: Only respond to authorized numbers
    if (!AUTHORIZED_NUMBERS.includes(sender)) {
        console.log(`[DEBUG] Unauthorized access attempt from ${sender}. Ignoring.`);
        return;
    }

    // MORE ROBUST DETECTION (handles facebook.com, fb.watch, fb.com, fb.me, and share links)
    const fbLinkRegex = /(facebook\.com|fb\.watch|fb\.com|fb\.me)/i;
    const hasFbLink = fbLinkRegex.test(msg.body);

    console.log(`[DEBUG] Message info: Type=${msg.type}, Sender=${sender}`);
    console.log(`[DEBUG] Body Length: ${msg.body.length}`);
    console.log(`[DEBUG] Text: ${msg.body.substring(0, 100)}`);
    console.log(`[DEBUG] hasFbLink: ${hasFbLink}`);

    if (hasFbLink) {
        console.log(`\n[${new Date().toLocaleTimeString()}] Processing link from: ${msg.from}`);

        // More flexible URL matching (catches links even if they have weird prefixes or extra text)
        const urlMatch = msg.body.match(/(https?:\/\/[^\s]+|www\.facebook\.com[^\s]+|fb\.watch[^\s]+|fb\.com[^\s]+)/i);

        if (!urlMatch) {
            console.log(`[DEBUG] hasFbLink was true, but could not extract a valid URL from: ${msg.body}`);
            return;
        }

        let url = urlMatch[0];
        // Prepend https:// if it's missing (e.g. if link started with www.facebook.com)
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        console.log(`[DEBUG] Extracted URL: ${url}`);
        const filename = `fb_video_${Date.now()}.mp4`;
        const filePath = path.join(TEMP_DIR, filename);

        try {
            await msg.reply('⏳ Hang on! I\'m fetching that video for you...');

            console.log('Downloading video...');
            // Wrap in a promise to enforce a 2-minute total timeout
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
                console.log('Cleaned up temporary file.');
            }
        }
    }
});

console.log('Starting WhatsApp Client...');
client.initialize().catch(err => {
    console.error('Initialization Error:', err);
});

// GLOBAL ERROR HANDLING TO PREVENT CRASHES
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
