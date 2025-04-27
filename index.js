const { ethers } = require('ethers');
const axios = require('axios');
const bip39 = require('bip39');
const fs = require('fs-extra');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const blessed = require('blessed');
const si = require('systeminformation');
const path = require('path');

const statsFilePath = path.join(__dirname, 'stats.json'); // For saving progress

let screen, statusBox, logBox, errorBox;
let stats = { success: 0, fail: 0, tries: 0, triesPerMin: 0, netRx: 0, netTx: 0, cpu: 0, ram: 0 };
let workers = [];

// Load saved stats on start
if (fs.existsSync(statsFilePath)) {
  stats = JSON.parse(fs.readFileSync(statsFilePath, 'utf8'));
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function generateSeedPhrase() {
  const randomLength = Math.random() > 0.5 ? 24 : 12;
  const randomBytes = crypto.randomBytes(randomLength === 24 ? 32 : 16);
  return bip39.entropyToMnemonic(randomBytes.toString('hex'));
}

async function scrapeBlockscan(address, type = 'etherscan') {
  const url = `https://${type}.com/address/${address}`;
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    const balance = $('#ContentPlaceHolder1_divSummary > div.row.g-3.mb-4 > div:nth-child(1) > div > div > div:nth-child(3)').text();
    const balanceResult = balance.split('\n')[4];
    return balanceResult !== undefined ? balanceResult : '$0.00';
  } catch (e) {
    await delay(10000);
    return '$0.00';
  }
}

async function networkUsage() {
  const netStats = await si.networkStats();
  const active = netStats.find(net => net.operstate === 'up') || netStats[0];
  stats.netRx = (active.rx_sec / 1024).toFixed(2);
  stats.netTx = (active.tx_sec / 1024).toFixed(2);
}

async function systemUsage() {
  const load = await si.currentLoad();
  const mem = await si.mem();
  stats.cpu = load.currentLoad.toFixed(2);
  stats.ram = ((mem.active / mem.total) * 100).toFixed(2);
}

async function bruteForceWorker() {
  while (true) {
    try {
      const seed = generateSeedPhrase();
      const wallet = ethers.Wallet.fromPhrase(seed);
      parentPort.postMessage({ type: 'log', text: `Checking ${wallet.address}` });

      const [ethBalance, bnbBalance] = await Promise.all([
        scrapeBlockscan(wallet.address, 'etherscan'),
        scrapeBlockscan(wallet.address, 'bscscan')
      ]);

      if (ethBalance !== '$0.00' || bnbBalance !== '$0.00') {
        await fs.appendFileSync('wallets.txt', `👾 Address: ${wallet.address}\n💬 Mnemonic: ${seed}\n🔑 Private Key: ${wallet.privateKey}\n🤑 ETH Balance: ${ethBalance}\n🤑 BNB Balance: ${bnbBalance}\n\n`);
        parentPort.postMessage({ type: 'winner', text: `WINNER FOUND: ${wallet.address}` });
      } else {
        parentPort.postMessage({ type: 'fail' });
      }
    } catch (err) {
      parentPort.postMessage({ type: 'error', text: `Error: ${err.message}` });
      parentPort.postMessage({ type: 'fail' });
    }
  }
}

function shutdown() {
  if (isMainThread) {
    console.log('\nShutting down...');
    workers.forEach(worker => worker.terminate());
    // Save progress before shutdown
    fs.writeFileSync(statsFilePath, JSON.stringify(stats, null, 2), 'utf8');
    process.exit(0);
  }
}

async function main() {
  let threadCount = parseInt(process.argv[2]);

  if (isNaN(threadCount) || threadCount <= 0) {
    console.error('Usage: node script.js <number_of_threads>');
    process.exit(1);
  }

  console.log(`Starting with ${threadCount} threads.`);

  screen = blessed.screen({
    smartCSR: true,
    title: 'Bruteforce Wallet Checker',
  });

  statusBox = blessed.box({
    top: 0,
    left: 'center',
    width: '80%',
    height: '30%',
    content: 'Starting...',
    tags: true,
    border: { type: 'line' },
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: '#f0f0f0' },
    }
  });

  logBox = blessed.log({
    top: '30%',
    left: 0,
    width: '50%',
    height: '70%',
    label: 'Logs',
    tags: true,
    border: { type: 'line' },
    style: { fg: 'green', border: { fg: '#f0f0f0' } },
    scrollbar: { ch: ' ', track: { bg: 'grey' }, style: { bg: 'white' } }
  });

  errorBox = blessed.log({
    top: '30%',
    left: '50%',
    width: '50%',
    height: '70%',
    label: 'Errors',
    tags: true,
    border: { type: 'line' },
    style: { fg: 'red', border: { fg: '#f0f0f0' } },
    scrollbar: { ch: ' ', track: { bg: 'grey' }, style: { bg: 'white' } }
  });

  screen.append(statusBox);
  screen.append(logBox);
  screen.append(errorBox);
  screen.render();

  screen.key(['escape', 'q', 'C-c'], shutdown);
  process.on('SIGINT', shutdown);

  setInterval(async () => {
    await Promise.all([
      networkUsage(),
      systemUsage()
    ]);
  }, 1000);

  // Update tries per minute
  setInterval(() => {
    stats.triesPerMin = stats.tries;
    stats.tries = 0;
  }, 60_000); // Every minute

  // Save stats every 5 minutes
  setInterval(() => {
    fs.writeFileSync(statsFilePath, JSON.stringify(stats, null, 2), 'utf8');
  }, 300_000); // 5 minutes in milliseconds

  setInterval(() => {
    statusBox.setContent(
      `{center}
        Bruteforce Wallet Checker\n
        {bold}Success:{/bold} ${stats.success}
        {bold}Failed:{/bold} ${stats.fail}
        {bold}Tries/min:{/bold} ${stats.triesPerMin}
        {bold}Net RX (KB/s):{/bold} ${stats.netRx}
        {bold}Net TX (KB/s):{/bold} ${stats.netTx}
        {bold}CPU Usage:{/bold} ${stats.cpu}%
        {bold}RAM Usage:{/bold} ${stats.ram}%
      {/center}`
    );
    screen.render();
  }, 500);

  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(__filename);
    workers.push(worker);
    worker.on('message', (msg) => {
      if (msg.type === 'winner') {
        stats.success++;
        logBox.add(`{yellow-fg}{bold}${msg.text}{/bold}{/yellow-fg}`);
      }
      if (msg.type === 'success') {
        stats.success++;
      }
      if (msg.type === 'fail') {
        stats.fail++;
      }
      if (msg.type === 'log') {
        logBox.add(msg.text);
      }
      if (msg.type === 'error') {
        errorBox.add(msg.text);
      }
      stats.tries++;
    });
    worker.on('error', (err) => errorBox.add(`Worker Error: ${err.message}`));
    worker.on('exit', (code) => {
      if (code !== 0) errorBox.add(`Worker stopped with exit code ${code}`);
    });
  }
}

if (isMainThread) {
  main();
} else {
  bruteForceWorker();
}
