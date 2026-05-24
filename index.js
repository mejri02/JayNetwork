const puppeteer = require('puppeteer-core');
const fs = require('fs');
const readline = require('readline');
const proxyChain = require('proxy-chain');

// ==================== CONFIGURATION ====================
const CHROME_PATH = '/usr/bin/chromium';
const ACCOUNTS_FILE = 'accounts.txt';
const PROXIES_FILE = 'proxies.txt';
const COMPLETED_TASKS_FILE = 'completed_tasks.json';

// Sleep until next day with random delay
const getNextRunDelay = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const randomHours = Math.floor(Math.random() * 3);
    const randomMinutes = Math.floor(Math.random() * 60);
    tomorrow.setHours(tomorrow.getHours() + randomHours);
    tomorrow.setMinutes(tomorrow.getMinutes() + randomMinutes);
    
    const delayMs = tomorrow - now;
    const hours = Math.floor(delayMs / (60 * 60 * 1000));
    const minutes = Math.floor((delayMs % (60 * 60 * 1000)) / (60 * 1000));
    
    return { delayMs, hours, minutes, nextRun: tomorrow };
};

const randomDelay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// 10 Random User Agents
const USER_AGENTS = [
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (query) => new Promise(resolve => rl.question(query, resolve));

function loadAccounts() {
    try {
        const content = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        const accounts = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        if (accounts.length === 0) throw new Error('No accounts found');
        return accounts;
    } catch (error) {
        console.error('❌ Error reading accounts.txt:', error.message);
        process.exit(1);
    }
}

let anonymizedProxies = [];
let rawProxies = [];

function loadProxies() {
    try {
        if (fs.existsSync(PROXIES_FILE)) {
            const content = fs.readFileSync(PROXIES_FILE, 'utf8');
            rawProxies = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            return rawProxies;
        }
    } catch(e) {}
    return [];
}

async function anonymizeProxies() {
    if (rawProxies.length === 0) return false;
    
    console.log(`\n📡 Testing ${rawProxies.length} proxies...`);
    anonymizedProxies = [];
    
    for (const proxy of rawProxies) {
        try {
            const anonymized = await proxyChain.anonymizeProxy(proxy);
            anonymizedProxies.push(anonymized);
            process.stdout.write('✅');
        } catch (e) {
            process.stdout.write('❌');
        }
    }
    console.log('\n');
    
    if (anonymizedProxies.length === 0) {
        console.log('⚠️ No working proxies - using direct\n');
        return false;
    }
    console.log(`✅ ${anonymizedProxies.length} proxies working\n`);
    return true;
}

function getProxyForIndex(index) {
    if (anonymizedProxies.length === 0) return null;
    return anonymizedProxies[index % anonymizedProxies.length];
}

async function closeProxies() {
    for (const proxy of anonymizedProxies) {
        try { await proxyChain.closeAnonymizedProxy(proxy, true); } catch(e) {}
    }
}

// Load completed tasks PER ACCOUNT
function loadCompletedTasks(accountId) {
    try {
        if (fs.existsSync(COMPLETED_TASKS_FILE)) {
            const data = JSON.parse(fs.readFileSync(COMPLETED_TASKS_FILE, 'utf8'));
            return data[accountId] || [];
        }
    } catch(e) {}
    return [];
}

function saveCompletedTasks(accountId, taskId) {
    try {
        let data = {};
        if (fs.existsSync(COMPLETED_TASKS_FILE)) {
            data = JSON.parse(fs.readFileSync(COMPLETED_TASKS_FILE, 'utf8'));
        }
        if (!data[accountId]) data[accountId] = [];
        if (!data[accountId].includes(taskId)) {
            data[accountId].push(taskId);
            fs.writeFileSync(COMPLETED_TASKS_FILE, JSON.stringify(data, null, 2));
        }
    } catch(e) {}
}

// ==================== BOT CLASS ====================
class JayNetworkBot {
    constructor(sessionToken, accountIndex, proxyUrl = null) {
        this.sessionToken = sessionToken;
        this.accountIndex = accountIndex;
        this.accountId = `account_${accountIndex}`;
        this.proxyUrl = proxyUrl;
        this.userAgent = USER_AGENTS[accountIndex % USER_AGENTS.length];
        this.completedTasks = loadCompletedTasks(this.accountId);
        this.browser = null;
        this.page = null;
        this.stats = { tasksCompleted: 0, totalEarned: 0, dailyClaims: 0 };
    }
    
    log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const prefix = `[${timestamp}] [Account ${this.accountIndex + 1}]`;
        const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️', task: '📋', claim: '🎁', skip: '⏭️', proxy: '🔒' };
        console.log(`${icons[type] || '📌'} ${prefix} ${message}`);
    }
    
    async init() {
        const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
        
        let launchOptions = {
            executablePath: CHROME_PATH,
            headless: true,
            args: args
        };
        
        if (this.proxyUrl) {
            launchOptions.args.push(`--proxy-server=${this.proxyUrl}`);
            this.log(`Using proxy`, 'proxy');
        }
        
        try {
            this.browser = await puppeteer.launch(launchOptions);
            this.page = await this.browser.newPage();
            await this.page.setViewport({ width: 375, height: 667 });
            await this.page.setUserAgent(this.userAgent);
            
            await this.page.setCookie({
                name: '__Secure-next-auth.session-token',
                value: this.sessionToken,
                domain: 'campaign.thejaynetwork.com',
                path: '/',
                secure: true,
                httpOnly: true
            });
            return true;
        } catch (error) {
            this.log(`Launch failed: ${error.message}`, 'error');
            return false;
        }
    }
    
    async navigateToDashboard() {
        this.log('Navigating to dashboard...', 'info');
        try {
            await this.page.goto('https://campaign.thejaynetwork.com/dashboard', {
                waitUntil: 'networkidle2',
                timeout: 45000
            });
            await randomDelay(2000, 4000);
            return true;
        } catch (error) {
            this.log(`Navigation failed: ${error.message}`, 'error');
            return false;
        }
    }
    
    async getDashboardData() {
        return await this.page.evaluate(async () => {
            const res = await fetch('/api/dashboard-data', { credentials: 'include' });
            return await res.json();
        });
    }
    
    async getReferralData() {
        return await this.page.evaluate(async () => {
            const res = await fetch('/api/referral', { credentials: 'include' });
            const data = await res.json();
            return data.success ? data.data : null;
        });
    }
    
    // Check if task should be skipped
    shouldSkipTask(task) {
        // Skip referral tasks
        if (task.category === 'referral') {
            this.log(`⏭️ Skipping referral task: ${task.title}`, 'skip');
            return true;
        }
        return false;
    }
    
    async completeTask(task) {
        // Skip if already completed by THIS account
        if (this.completedTasks.includes(task.id)) {
            return false;
        }
        
        // Skip referral tasks
        if (this.shouldSkipTask(task)) {
            return false;
        }
        
        this.log(`Attempting: ${task.title} (+${task.reward} JAY)`, 'task');
        await randomDelay(1000, 3000);
        
        try {
            // Handle duration tasks
            if (task.verifyType === 'duration' && task.durationSecs) {
                this.log(`⏳ Waiting ${task.durationSecs} seconds...`, 'warning');
                for (let i = task.durationSecs; i > 0; i -= 10) {
                    if (i % 10 === 0 && i > 0) {
                        this.log(`   ${i} seconds remaining...`, 'info');
                    }
                    await randomDelay(9000, 11000);
                }
            }
            
            // Handle ecosystem tasks - open URL if provided
            if (task.category === 'ecosystem' && task.actionUrl) {
                const newPage = await this.browser.newPage();
                await newPage.goto(task.actionUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                await randomDelay(5000, 10000);
                await newPage.close();
            }
            
            // Attempt to complete the task
            const result = await this.page.evaluate(async (taskId) => {
                const res = await fetch('/api/task/complete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskId: taskId, proof: `completed-${Date.now()}` }),
                    credentials: 'include'
                });
                return res.json();
            }, task.id);
            
            if (result.success) {
                this.stats.tasksCompleted++;
                this.stats.totalEarned += task.reward;
                saveCompletedTasks(this.accountId, task.id);
                this.log(`✅ Completed! +${task.reward} JAY`, 'success');
                return true;
            } else {
                this.log(`⚠️ Failed: ${result.error || 'Unknown'} - will retry later`, 'warning');
                return false;
            }
        } catch (error) {
            this.log(`⚠️ Error: ${error.message} - will retry later`, 'warning');
            return false;
        }
    }
    
    async claimDailyLogin() {
        this.log('Checking daily login...', 'info');
        
        try {
            const dailyStatus = await this.page.evaluate(async () => {
                try {
                    const res = await fetch('/api/daily-login', { credentials: 'include' });
                    return await res.json();
                } catch(e) {
                    return { success: false };
                }
            });
            
            if (dailyStatus.success && dailyStatus.data && !dailyStatus.data.claimedToday) {
                const day = dailyStatus.data.currentDay;
                const reward = (day === 7 || day === 14) ? 10 : 5;
                
                this.log(`Day ${day} available! Claiming +${reward} JAY...`, 'claim');
                await randomDelay(1000, 2000);
                
                const claimResult = await this.page.evaluate(async (day) => {
                    const res = await fetch('/api/daily-login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ day: day }),
                        credentials: 'include'
                    });
                    return res.json();
                }, day);
                
                if (claimResult.success) {
                    this.stats.dailyClaims++;
                    this.stats.totalEarned += reward;
                    this.log(`✅ Day ${day} claimed! +${reward} JAY`, 'success');
                    return true;
                }
            } else if (dailyStatus.success && dailyStatus.data?.claimedToday) {
                this.log(`Already claimed today`, 'info');
            }
        } catch (error) {
            this.log(`Daily login check failed`, 'warning');
        }
        return false;
    }
    
    async processAllTasks() {
        const data = await this.getDashboardData();
        const tasks = data.tasks || [];
        const pendingTasks = tasks.filter(t => t.status === 'pending');
        const tasksToAttempt = pendingTasks.filter(t => !this.completedTasks.includes(t.id));
        
        this.log(`📊 Found ${pendingTasks.length} pending (${tasksToAttempt.length} to attempt)`, 'info');
        
        let attempted = 0;
        for (const task of tasksToAttempt) {
            await randomDelay(3000, 8000);
            const success = await this.completeTask(task);
            if (success) attempted++;
        }
        
        if (tasksToAttempt.length > 0) {
            this.log(`📊 Completed ${attempted}/${tasksToAttempt.length} tasks`, 'info');
        }
    }
    
    async displayDashboard() {
        const data = await this.getDashboardData();
        const tasks = data.tasks || [];
        const completedTasks = tasks.filter(t => t.status === 'completed');
        const totalEarned = tasks.reduce((sum, t) => sum + (t.status === 'completed' ? t.reward : 0), 0);
        
        console.log('\n' + '═'.repeat(50));
        console.log(`  📊 ACCOUNT ${this.accountIndex + 1}`);
        console.log('═'.repeat(50));
        console.log(`  💰 EARNED: ${totalEarned} JAY`);
        console.log(`  ✅ COMPLETED: ${completedTasks.length}/${tasks.length}`);
        
        const referral = await this.getReferralData();
        if (referral && referral.referralCode) {
            console.log(`  🔗 REF CODE: ${referral.referralCode}`);
        }
        console.log('═'.repeat(50) + '\n');
    }
    
    async runOnce() {
        try {
            const initSuccess = await this.init();
            if (!initSuccess) return null;
            
            const navSuccess = await this.navigateToDashboard();
            if (!navSuccess) {
                await this.browser.close();
                return null;
            }
            
            await this.displayDashboard();
            await this.claimDailyLogin();
            await randomDelay(2000, 4000);
            await this.processAllTasks();
            await randomDelay(3000, 5000);
            await this.browser.close();
            return this.stats;
        } catch (error) {
            this.log(`Error: ${error.message}`, 'error');
            if (this.browser) await this.browser.close();
            return null;
        }
    }
}

// ==================== MAIN ====================
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function showMenu() {
    console.clear();
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                    🤖 JAY NETWORK BOT                     ║');
    console.log('║              Daily Check-in + Auto Tasks                  ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  1. 🚀 Run WITHOUT proxies (direct connection)      │');
    console.log('  │  2. 🔒 Run WITH proxies from proxies.txt            │');
    console.log('  │  3. ❌ Exit                                         │');
    console.log('  └─────────────────────────────────────────────────────┘\n');
    
    const answer = await question('  👉 Select option (1-3): ');
    return answer.trim();
}

async function runCycle(accounts, useProxies) {
    console.log('\n' + '🔄'.repeat(30));
    console.log(`  New cycle at ${new Date().toLocaleString()}`);
    console.log('🔄'.repeat(30) + '\n');
    
    let cycleStats = { tasksCompleted: 0, totalEarned: 0, dailyClaims: 0 };
    
    for (let i = 0; i < accounts.length; i++) {
        console.log(`\n  🚀 ACCOUNT ${i + 1}/${accounts.length}`);
        console.log('  ' + '─'.repeat(40));
        
        const proxyUrl = useProxies ? getProxyForIndex(i) : null;
        const bot = new JayNetworkBot(accounts[i], i, proxyUrl);
        const stats = await bot.runOnce();
        
        if (stats) {
            cycleStats.tasksCompleted += stats.tasksCompleted;
            cycleStats.totalEarned += stats.totalEarned;
            cycleStats.dailyClaims += stats.dailyClaims;
        }
        
        if (i < accounts.length - 1) {
            const delaySec = randomInt(30, 60);
            console.log(`\n  ⏳ Waiting ${delaySec}s before next account...`);
            await sleep(delaySec * 1000);
        }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log(`  📊 TODAY: +${cycleStats.tasksCompleted} tasks | +${cycleStats.totalEarned} JAY`);
    console.log('='.repeat(50));
    
    return cycleStats;
}

async function main() {
    const choice = await showMenu();
    
    if (choice === '3') {
        console.log('\n  👋 Goodbye!\n');
        rl.close();
        process.exit(0);
    }
    
    const useProxies = (choice === '2');
    
    if (useProxies) {
        const proxies = loadProxies();
        if (proxies.length === 0) {
            console.log('\n  ❌ No proxies found in proxies.txt');
            rl.close();
            process.exit(1);
        }
        await anonymizeProxies();
    }
    
    const accounts = loadAccounts();
    
    console.log('\n' + '─'.repeat(50));
    console.log(`  📡 Mode: ${(useProxies && anonymizedProxies.length > 0) ? 'Proxy' : 'Direct'}`);
    console.log(`  📊 Accounts: ${accounts.length}`);
    console.log('─'.repeat(50));
    
    rl.close();
    await sleep(2000);
    
    process.on('exit', closeProxies);
    
    let totalStats = { tasksCompleted: 0, totalEarned: 0, dailyClaims: 0 };
    let cycleNum = 0;
    
    while (true) {
        cycleNum++;
        console.log(`\n  🏁 DAY #${cycleNum} - ${new Date().toLocaleString()}\n`);
        
        const cycleStats = await runCycle(accounts, useProxies && anonymizedProxies.length > 0);
        
        totalStats.tasksCompleted += cycleStats.tasksCompleted;
        totalStats.totalEarned += cycleStats.totalEarned;
        totalStats.dailyClaims += cycleStats.dailyClaims;
        
        console.log(`\n  📈 TOTAL: ${totalStats.tasksCompleted} tasks | ${totalStats.totalEarned} JAY`);
        
        const { delayMs, hours, minutes, nextRun } = getNextRunDelay();
        
        console.log(`\n  💤 Sleeping until tomorrow (${hours}h ${minutes}m random delay)`);
        console.log(`  🔜 Next check: ${nextRun.toLocaleString()}\n`);
        
        await sleep(delayMs);
    }
}

main().catch(console.error);